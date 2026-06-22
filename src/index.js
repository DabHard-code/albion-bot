import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

const requiredEnv = ["DISCORD_TOKEN", "CLIENT_ID"];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error("Environment check failed:", {
      DISCORD_TOKEN: process.env.DISCORD_TOKEN ? "set" : "missing",
      CLIENT_ID: process.env.CLIENT_ID ? "set" : "missing",
      OFFICER_ROLE_NAME: process.env.OFFICER_ROLE_NAME ? "set" : "default Officer",
      AUDIT_CHANNEL_NAME: process.env.AUDIT_CHANNEL_NAME ? "set" : "default payout-audit",
    });
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  legacyGuildId: process.env.LEGACY_GUILD_ID,
  officerRoleName: process.env.OFFICER_ROLE_NAME ?? "Officer",
  auditChannelName: process.env.AUDIT_CHANNEL_NAME ?? "payout-audit",
};

const botVersion = "2026-06-21.1";

mkdirSync("data", { recursive: true });
const db = new DatabaseSync("data/ledger.db");
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS balances (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    tax_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (tax_basis_points BETWEEN 0 AND 10000)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    amount INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const commands = [
  new SlashCommandBuilder()
    .setName("bal")
    .setDescription("View your balance or another player's balance")
    .addUserOption((option) =>
      option.setName("player").setDescription("Player to view"),
    ),
  new SlashCommandBuilder()
    .setName("zax-is-a-good-dog")
    .setDescription("Zax is a good dog"),
  new SlashCommandBuilder()
    .setName("version")
    .setDescription("Show the running bot version"),
  (() => {
    const command = new SlashCommandBuilder()
      .setName("split")
      .setDescription("Split silver evenly between selected players after guild tax")
      .addStringOption((option) =>
        option
          .setName("total")
          .setDescription("Total to split, such as 25m")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("What this split is for").setRequired(true),
      )
      .addUserOption((option) =>
        option.setName("player1").setDescription("First player").setRequired(true),
      )
      .addUserOption((option) =>
        option.setName("player2").setDescription("Second player").setRequired(true),
      );

    for (let index = 3; index <= 20; index += 1) {
      command.addUserOption((option) =>
        option.setName(`player${index}`).setDescription(`Player ${index}`),
      );
    }
    command.addAttachmentOption((option) =>
      option.setName("screenshot").setDescription("Optional party screenshot for reference"),
    );
    return command;
  })(),
  new SlashCommandBuilder()
    .setName("add-money")
    .setDescription("Add to a player's running total")
    .addUserOption((option) =>
      option.setName("player").setDescription("Player to credit").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("amount").setDescription("Amount, such as 500k or 2.5m").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Why this payout was added").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("transfer")
    .setDescription("Transfer part of your running total to another player")
    .addUserOption((option) =>
      option.setName("player").setDescription("Player receiving the transfer").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("amount").setDescription("Amount, such as 500k or 2.5m").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Optional transfer note"),
    ),
  new SlashCommandBuilder()
    .setName("tax")
    .setDescription("View or set the guild tax percentage")
    .addNumberOption((option) =>
      option
        .setName("percent")
        .setDescription("New guild tax percentage, such as 10")
        .setMinValue(0)
        .setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName("payout")
    .setDescription("Mark a player's full running total paid and set it to zero")
    .addUserOption((option) =>
      option.setName("player").setDescription("Player being paid").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Optional payout note"),
    ),
  new SlashCommandBuilder()
    .setName("audit")
    .setDescription("View recent payout activity")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Number of entries to show")
        .setMinValue(1)
        .setMaxValue(20),
    ),
].map((command) => command.toJSON());

function parseAmount(input) {
  const normalized = input.trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^(\d+(?:\.\d{1,3})?)([kmb])?$/);
  if (!match) throw new Error("Use a positive amount such as `500k`, `2.5m`, or `1000000`.");

  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const amount = Math.round(Number(match[1]) * (multipliers[match[2]] ?? 1));
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("That amount is too large or invalid.");
  }
  return amount;
}

function formatSilver(amount) {
  return `${new Intl.NumberFormat("en-US").format(amount)} silver`;
}

function hasRoleNamed(interaction, roleName) {
  const roles = interaction.member.roles;
  if (Array.isArray(roles)) {
    return roles.some(
      (roleId) =>
        interaction.guild.roles.cache.get(roleId)?.name.toLowerCase() === roleName.toLowerCase(),
    );
  }
  return roles.cache.some((role) => role.name.toLowerCase() === roleName.toLowerCase());
}

function canManagePayouts(interaction) {
  return hasRoleNamed(interaction, config.officerRoleName);
}

function requireOfficer(interaction) {
  if (!canManagePayouts(interaction)) {
    throw new Error(`You need the ${config.officerRoleName} role to use this command.`);
  }
}

function getBalance(guildId, userId) {
  return (
    db
      .prepare("SELECT amount FROM balances WHERE guild_id = ? AND user_id = ?")
      .get(guildId, userId)?.amount ?? 0
  );
}

function getTaxBasisPoints(guildId) {
  return (
    db
      .prepare("SELECT tax_basis_points FROM guild_settings WHERE guild_id = ?")
      .get(guildId)?.tax_basis_points ?? 0
  );
}

function setTaxBasisPoints(guildId, taxBasisPoints) {
  db.prepare(`
    INSERT INTO guild_settings (guild_id, tax_basis_points) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET tax_basis_points = excluded.tax_basis_points
  `).run(guildId, taxBasisPoints);
}

function setBalance(guildId, userId, amount) {
  db.prepare(`
    INSERT INTO balances (guild_id, user_id, amount) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET amount = excluded.amount
  `).run(guildId, userId, amount);
}

function record(guildId, actorId, action, targetId, amount, reason) {
  db.prepare(`
    INSERT INTO transactions (guild_id, actor_id, action, target_id, amount, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, actorId, action, targetId, amount, reason ?? null);
}

async function postAudit(interaction, title, details) {
  const channel = interaction.guild.channels.cache.find(
    (candidate) =>
      candidate.isTextBased() &&
      candidate.name.toLowerCase() === config.auditChannelName.toLowerCase(),
  );
  if (!channel?.isTextBased()) {
    console.warn(`No accessible #${config.auditChannelName} channel in ${interaction.guild.name}.`);
    return;
  }

  try {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(details)
          .setColor(0xd4af37)
          .setFooter({ text: `Authorized by ${interaction.user.username}` })
          .setTimestamp(),
      ],
    });
  } catch (error) {
    console.warn(
      `Could not post audit log to #${config.auditChannelName} in ${interaction.guild.name}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands,
  });
  if (config.legacyGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.legacyGuildId), {
      body: [],
    });
  }
  console.log(`Ready as ${client.user.tag}. Registered ${commands.length} global commands. Version ${botVersion}.`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  try {
    await interaction.deferReply({ ephemeral: interaction.commandName === "audit" });
    const guildId = interaction.guildId;
    const actorId = interaction.user.id;

    if (interaction.commandName === "zax-is-a-good-dog") {
      return interaction.editReply("🐶");
    }

    if (interaction.commandName === "bal") {
      const player = interaction.options.getUser("player") ?? interaction.user;
      return interaction.editReply(
        `${player}'s balance is **${formatSilver(getBalance(guildId, player.id))}**.`,
      );
    }

    if (interaction.commandName === "version") {
      return interaction.editReply(`Albion payout bot version **${botVersion}**.`);
    }

    if (interaction.commandName === "split") {
      requireOfficer(interaction);
      const total = parseAmount(interaction.options.getString("total", true));
      const reason = interaction.options.getString("reason", true);
      const screenshot = interaction.options.getAttachment("screenshot");
      const players = [];
      for (let index = 1; index <= 20; index += 1) {
        const player = interaction.options.getUser(`player${index}`);
        if (player) players.push(player);
      }
      if (players.some((player) => player.bot)) {
        throw new Error("Bots cannot receive split shares.");
      }
      if (screenshot && !screenshot.contentType?.startsWith("image/")) {
        throw new Error("If you attach a screenshot, it needs to be an image.");
      }
      if (new Set(players.map((player) => player.id)).size !== players.length) {
        throw new Error("Each player can only be selected once.");
      }

      const taxBasisPoints = getTaxBasisPoints(guildId);
      const taxAmount = Math.floor((total * taxBasisPoints) / 10_000);
      const playerTotal = total - taxAmount;
      if (playerTotal < players.length) {
        throw new Error("The total must be at least one silver per selected player.");
      }

      const baseShare = Math.floor(playerTotal / players.length);
      const remainder = playerTotal % players.length;
      const shares = players.map((player, index) => ({
        player,
        amount: baseShare + (index < remainder ? 1 : 0),
      }));

      db.exec("BEGIN");
      try {
        for (const share of shares) {
          setBalance(
            guildId,
            share.player.id,
            getBalance(guildId, share.player.id) + share.amount,
          );
          record(
            guildId,
            actorId,
            "PLAYER_SPLIT",
            share.player.id,
            share.amount,
            reason,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const splitDetails = shares
        .map(
          (share) =>
            `${share.player}: **${formatSilver(share.amount)}**`,
        )
        .join("\n");
      const summary =
        `Gross total: **${formatSilver(total)}**\n` +
        `Guild tax (${taxBasisPoints / 100}%): **${formatSilver(taxAmount)}**\n` +
        `Player total: **${formatSilver(playerTotal)}**\n` +
        `Split between **${players.length} selected players**.\n` +
        `Base share: **${formatSilver(baseShare)}**` +
        (remainder
          ? `\n${remainder} member${remainder === 1 ? "" : "s"} received 1 extra silver.`
          : "");

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Split Complete")
            .setDescription(
              `${summary}\n\n${splitDetails}\n\nReason: ${reason}` +
                (screenshot ? "\nScreenshot attached for reference." : ""),
            )
            .setColor(0xd4af37),
        ],
      });
      return postAudit(
        interaction,
        "Split completed",
        `${summary}\n\n${splitDetails}\n\nReason: ${reason}` +
          (screenshot ? "\nScreenshot attached for reference." : ""),
      );
    }

    if (interaction.commandName === "add-money") {
      requireOfficer(interaction);
      const member = interaction.options.getUser("player", true);
      const reason = interaction.options.getString("reason", true);
      const oldBalance = getBalance(guildId, member.id);
      const amount = parseAmount(interaction.options.getString("amount", true));
      const newBalance = oldBalance + amount;

      setBalance(guildId, member.id, newBalance);
      record(guildId, actorId, "ADD_MONEY", member.id, amount, reason);
      await interaction.editReply(`${member}'s balance is now **${formatSilver(newBalance)}**.`);
      return postAudit(interaction, "Money added", `${member}: **${formatSilver(amount)}**\nReason: ${reason}`);
    }

    if (interaction.commandName === "transfer") {
      const player = interaction.options.getUser("player", true);
      if (player.bot || player.id === actorId) {
        throw new Error("Choose another player.");
      }

      const amount = parseAmount(interaction.options.getString("amount", true));
      const reason = interaction.options.getString("reason") ?? "Player transfer";
      const senderBalance = getBalance(guildId, actorId);
      if (senderBalance < amount) {
        throw new Error("You do not have enough in your running total.");
      }

      db.exec("BEGIN");
      try {
        setBalance(guildId, actorId, senderBalance - amount);
        setBalance(guildId, player.id, getBalance(guildId, player.id) + amount);
        record(guildId, actorId, "PLAYER_TRANSFER", player.id, amount, reason);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      await interaction.editReply(
        `Transferred **${formatSilver(amount)}** to ${player}. Your running total is now **${formatSilver(senderBalance - amount)}**.`,
      );
      return postAudit(
        interaction,
        "Player transfer",
        `${interaction.user} transferred **${formatSilver(amount)}** to ${player}.\nReason: ${reason}`,
      );
    }

    if (interaction.commandName === "tax") {
      requireOfficer(interaction);
      const percent = interaction.options.getNumber("percent");
      if (percent === null) {
        return interaction.editReply(`The guild tax is **${getTaxBasisPoints(guildId) / 100}%**.`);
      }

      const taxBasisPoints = Math.round(percent * 100);
      setTaxBasisPoints(guildId, taxBasisPoints);
      record(guildId, actorId, "SET_GUILD_TAX", null, taxBasisPoints, `${percent}%`);
      await interaction.editReply(`Guild tax set to **${taxBasisPoints / 100}%**.`);
      return postAudit(interaction, "Guild tax changed", `Guild tax is now **${taxBasisPoints / 100}%**.`);
    }

    if (interaction.commandName === "payout") {
      requireOfficer(interaction);
      const member = interaction.options.getUser("player", true);
      const reason = interaction.options.getString("reason") ?? "Payout completed";
      const amount = getBalance(guildId, member.id);
      if (amount <= 0) throw new Error("That member has no balance.");

      setBalance(guildId, member.id, 0);
      record(guildId, actorId, "PAYOUT_COMPLETED", member.id, amount, reason);
      await interaction.editReply(`Paid ${member} **${formatSilver(amount)}**. Their running total is now **0 silver**.`);
      return postAudit(interaction, "Payout completed", `${member} received **${formatSilver(amount)}**.\nReason: ${reason}`);
    }

    if (interaction.commandName === "audit") {
      requireOfficer(interaction);
      const count = interaction.options.getInteger("count") ?? 10;
      const rows = db
        .prepare("SELECT * FROM transactions WHERE guild_id = ? ORDER BY id DESC LIMIT ?")
        .all(guildId, count);
      const text = rows.length
        ? rows
            .map((row) => {
              const target = row.target_id ? ` -> <@${row.target_id}>` : "";
              const reason = row.reason ? `\n${row.reason}` : "";
              return `**#${row.id} ${row.action.replaceAll("_", " ")}** - ${formatSilver(row.amount)}${target}\nBy <@${row.actor_id}>${reason}`;
            })
            .join("\n\n")
        : "No payout activity yet.";

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Recent Payout Activity")
            .setDescription(text)
            .setColor(0xd4af37),
        ],
      });
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    console.error(`Command /${interaction.commandName} failed:`, error);
    const reply = { content: message, embeds: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply({ ...reply, ephemeral: true }).catch(() => {});
  }
});

client.login(config.token);
