import 'dotenv/config'
import { Telegraf } from 'telegraf'
import mysql from 'mysql2/promise'

const BOT_TOKEN = process.env.BOT_TOKEN
const pool = mysql.createPool(process.env.DATABASE_URL)

console.log("Starting bot...")
console.log("BOT_TOKEN:", !!BOT_TOKEN)
console.log("DATABASE_URL:", !!process.env.DATABASE_URL)

const bot = new Telegraf(BOT_TOKEN)

// یک دستور ساده برای تست
bot.start((ctx) => ctx.reply("Bot is running!"))

// این خط باعث می‌شود کانتینر stay alive باشه
bot.launch()
console.log("Bot launched!")

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
