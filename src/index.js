import { randomUUID } from "node:crypto";
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

const rawAllowedChannelIds = [
  ...(process.env.ALLOWED_CHANNEL_IDS ?? "").split(","),
  process.env.ALLOWED_CHANNEL_ID ?? "",
]
  .map((id) => id.trim().replace(/^["']|["']$/g, ""))
  .filter(Boolean);
const allowedChannelIds = [...new Set(rawAllowedChannelIds)];

const requiredEnv = ["DISCORD_TOKEN", "CLIENT_ID"];
for (const name of requiredEnv) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error("Environment check failed:", {
      DISCORD_TOKEN: process.env.DISCORD_TOKEN ? "set" : "missing",
      CLIENT_ID: process.env.CLIENT_ID ? "set" : "missing",
      OFFICER_ROLE_NAME: process.env.OFFICER_ROLE_NAME ? "set" : "default Officer",
      AUDIT_CHANNEL_NAME: process.env.AUDIT_CHANNEL_NAME ? "set" : "default payout-audit",
      ALLOWED_CHANNEL_IDS: allowedChannelIds.length ? "set" : "missing",
    });
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!allowedChannelIds.length) {
  throw new Error("ALLOWED_CHANNEL_IDS must include at least one Discord channel ID.");
}
for (const channelId of allowedChannelIds) {
  if (!/^\d{17,20}$/.test(channelId)) {
    throw new Error("ALLOWED_CHANNEL_IDS must contain Discord channel IDs, such as 1518451509052837979.");
  }
}

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  legacyGuildId: process.env.LEGACY_GUILD_ID,
  officerRoleName: process.env.OFFICER_ROLE_NAME ?? "Officer",
  auditChannelName: process.env.AUDIT_CHANNEL_NAME ?? "payout-audit",
  allowedChannelIds,
};

const botVersion = "2026-06-27.1";

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
    split_group_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const transactionColumns = db.prepare("PRAGMA table_info(transactions)").all();
if (!transactionColumns.some((column) => column.name === "split_group_id")) {
  db.exec("ALTER TABLE transactions ADD COLUMN split_group_id TEXT");
}

const commands = [
  new SlashCommandBuilder()
    .setName("bal")
    .setDescription("View your balance or another player's balance")
    .addUserOption((option) =>
      option.setName("player").setDescription("Player to view"),
    ),
  new SlashCommandBuilder()
    .setName("bal-leaderboard")
    .setDescription("Show the top 15 player balances"),
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
      .addStringOption((option) =>
        option
          .setName("players")
          .setDescription("Paste player mentions or IDs, such as @A @B @C")
          .setRequired(true),
      );
    command.addAttachmentOption((option) =>
      option.setName("screenshot").setDescription("Optional party screenshot for reference"),
    );
    return command;
  })(),
  new SlashCommandBuilder()
    .setName("undo-last-split")
    .setDescription("Undo and remove the most recent split"),
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

function parsePlayerIds(input) {
  const ids = input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.match(/^<@!?(\d{17,20})>$/)?.[1] ?? token.match(/^(\d{17,20})$/)?.[1])
    .filter(Boolean);

  if (!ids.length) {
    throw new Error("Paste at least one player mention or Discord user ID.");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Each player can only be listed once.");
  }
  return ids;
}

function formatPlayerList(shares) {
  const lines = shares.map(
    (share) => `<@${share.playerId}>: **${formatSilver(share.amount)}**`,
  );
  const text = lines.join("\n");
  if (text.length <= 3000) return text;

  const preview = lines.slice(0, 30).join("\n");
  return `${preview}\n...and ${lines.length - 30} more players.`;
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

function record(guildId, actorId, action, targetId, amount, reason, splitGroupId = null) {
  db.prepare(`
    INSERT INTO transactions (guild_id, actor_id, action, target_id, amount, reason, split_group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, actorId, action, targetId, amount, reason ?? null, splitGroupId);
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
  console.log(
    `Ready as ${client.user.tag}. Registered ${commands.length} global commands. Version ${botVersion}. ` +
      `Commands locked to channels ${config.allowedChannelIds.join(", ")}.`,
  );
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  try {
    if (!config.allowedChannelIds.includes(interaction.channelId)) {
      return interaction.reply({
        content: "fuck you, use money channel",
        ephemeral: true,
      });
    }

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

    if (interaction.commandName === "bal-leaderboard") {
      const rows = db
        .prepare("SELECT user_id, amount FROM balances WHERE guild_id = ? AND amount > 0 ORDER BY amount DESC LIMIT 15")
        .all(guildId);
      const text = rows.length
        ? rows
            .map((row, index) => `${index + 1}. <@${row.user_id}> - **${formatSilver(row.amount)}**`)
            .join("\n")
        : "No one has a balance yet.";

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Balance Leaderboard")
            .setDescription(text)
            .setColor(0xd4af37),
        ],
      });
    }

    if (interaction.commandName === "version") {
      return interaction.editReply(`Albion payout bot version **${botVersion}**.`);
    }

    if (interaction.commandName === "split") {
      requireOfficer(interaction);
      const total = parseAmount(interaction.options.getString("total", true));
      const reason = interaction.options.getString("reason", true);
      const screenshot = interaction.options.getAttachment("screenshot");
      const playerIds = parsePlayerIds(interaction.options.getString("players", true));
      if (screenshot && !screenshot.contentType?.startsWith("image/")) {
        throw new Error("If you attach a screenshot, it needs to be an image.");
      }

      const taxBasisPoints = getTaxBasisPoints(guildId);
      const taxAmount = Math.floor((total * taxBasisPoints) / 10_000);
      const playerTotal = total - taxAmount;
      if (playerTotal < playerIds.length) {
        throw new Error("The total must be at least one silver per selected player.");
      }

      const baseShare = Math.floor(playerTotal / playerIds.length);
      const remainder = playerTotal % playerIds.length;
      const splitGroupId = randomUUID();
      const shares = playerIds.map((playerId, index) => ({
        playerId,
        amount: baseShare + (index < remainder ? 1 : 0),
      }));

      db.exec("BEGIN");
      try {
        for (const share of shares) {
          setBalance(
            guildId,
            share.playerId,
            getBalance(guildId, share.playerId) + share.amount,
          );
          record(
            guildId,
            actorId,
            "PLAYER_SPLIT",
            share.playerId,
            share.amount,
            reason,
            splitGroupId,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const splitDetails = formatPlayerList(shares);
      const summary =
        `Gross total: **${formatSilver(total)}**\n` +
        `Guild tax (${taxBasisPoints / 100}%): **${formatSilver(taxAmount)}**\n` +
        `Player total: **${formatSilver(playerTotal)}**\n` +
        `Split between **${playerIds.length} selected players**.\n` +
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

    if (interaction.commandName === "undo-last-split") {
      requireOfficer(interaction);
      const latest = db
        .prepare(`
          SELECT split_group_id
          FROM transactions
          WHERE guild_id = ?
            AND action = 'PLAYER_SPLIT'
            AND split_group_id IS NOT NULL
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(guildId);
      if (!latest?.split_group_id) {
        throw new Error("No undoable split found. Only splits made after the undo update can be undone.");
      }

      const rows = db
        .prepare(`
          SELECT target_id, amount, reason
          FROM transactions
          WHERE guild_id = ?
            AND action = 'PLAYER_SPLIT'
            AND split_group_id = ?
          ORDER BY id ASC
        `)
        .all(guildId, latest.split_group_id);
      if (!rows.length) {
        throw new Error("No undoable split found.");
      }

      for (const row of rows) {
        const balance = getBalance(guildId, row.target_id);
        if (balance < row.amount) {
          throw new Error(
            `Cannot undo because <@${row.target_id}> only has **${formatSilver(balance)}**, ` +
              `but this undo needs to remove **${formatSilver(row.amount)}**.`,
          );
        }
      }

      db.exec("BEGIN");
      try {
        for (const row of rows) {
          setBalance(guildId, row.target_id, getBalance(guildId, row.target_id) - row.amount);
        }
        db
          .prepare("DELETE FROM transactions WHERE guild_id = ? AND split_group_id = ?")
          .run(guildId, latest.split_group_id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const totalRemoved = rows.reduce((sum, row) => sum + row.amount, 0);
      const undoneDetails = formatPlayerList(
        rows.map((row) => ({ playerId: row.target_id, amount: row.amount })),
      );
      const reason = rows[0]?.reason ?? "No reason recorded";
      const summary =
        `Removed **${formatSilver(totalRemoved)}** from **${rows.length} players**.\n` +
        `Original reason: ${reason}\n\n${undoneDetails}`;

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Last Split Undone")
            .setDescription(summary)
            .setColor(0xd4af37),
        ],
      });
      return postAudit(interaction, "Split undone", summary);
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
