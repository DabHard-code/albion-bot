# Albion Payout Bot

A focused Discord ledger for Albion Online guild payouts. It has no robbery,
crime, gambling, work, shop, or other game-economy commands.

## What it tracks

- Each member's running balance
- The guild tax percentage used for splits
- Every balance change in a permanent audit ledger
- One `Officer` role for every manager action

The bot tracks silver but does not transfer silver inside Albion Online.

## Commands

| Command | Who can use it | Purpose |
| --- | --- | --- |
| `/zax-is-a-good-dog` | Everyone | Dog emoji |
| `/bal [player]` | Everyone | View your balance or another player's balance |
| `/split total reason player1 player2...` | Officer | Deduct tax, then split between selected players |
| `/tax [percent]` | Officer | View or set the guild tax percentage |
| `/add-money player amount reason` | Officer | Add to a player's running total |
| `/transfer player amount [reason]` | Everyone | Transfer part of your running total to another player |
| `/payout player [reason]` | Officer | Mark the full running total paid and set it to zero |
| `/audit [count]` | Officer | View recent payout activity |

Members with a Discord role named `Officer` can use every management command.

## Setup

1. Create an application and bot at the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Under OAuth2 URL Generator, select `bot` and `applications.commands`, then
   invite it with View Channels, Send Messages, and Embed Links permissions.
3. Create an `Officer` role. This is the only bot-management role.
4. Copy `.env.example` to `.env` and fill in the IDs and bot token.
5. Install and run:

```powershell
npm.cmd install
npm.cmd start
```

Commands are registered globally so the bot can work in multiple Discord
servers. Balances, tax settings, and history remain separate for each server.
Create a `#payout-audit` channel in each server that wants audit
logs. Balances are stored in `data/ledger.db`; include that file in backups.

## Split example

First set the tax with `/tax percent:10`. Then use `/split total:2m
reason:"roads run"` and select the players with `player1`, `player2`, and any
extra player slots you need. The bot deducts `200k` as guild tax and divides the
remaining `1.8m` between the selected players. The tax amount is shown in the
result.
