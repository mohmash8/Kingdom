// Emperor Group Manager Bot – "Imperial Edition" 👑
// Telegraf v4 (Node.js 18+)
// ==============================================
// (c) Fixed for MySQL + ESM + Telegraf v4 webhook
// ==============================================

import 'dotenv/config'
import express from 'express'
import { Telegraf, Markup } from 'telegraf'
import { message } from 'telegraf/filters'
import mysql from 'mysql2/promise'

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env')

const FORCE_JOIN = process.env.FORCE_JOIN || '' // e.g. @its4_Four (empty to disable)
const CAPTCHA_TIMEOUT_SEC = +(process.env.CAPTCHA_TIMEOUT_SEC || 120)
const WEBHOOK_URL = process.env.WEBHOOK_URL
const PORT = process.env.PORT || 3000

// ---------- BOT & DB ----------
console.log('Bot starting...')
console.log('BOT_TOKEN:', !!BOT_TOKEN)

const bot = new Telegraf(BOT_TOKEN)

// اگر DATABASE_URL داری (مثلاً mysql://user:pass@host:port/dbname)
// یا از گزینه‌های جداگانه استفاده کن
const pool = await mysql.createPool({
  uri: process.env.DATABASE_URL, // اگر نداری، کامنت کن و بقیه‌ی فیلدها رو پر کن
  // host: process.env.DB_HOST,
  // user: process.env.DB_USER,
  // password: process.env.DB_PASS,
  // database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
})

// ---------- DB MIGRATIONS ----------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      chat_id BIGINT PRIMARY KEY,
      title VARCHAR(255),
      emperor_id BIGINT,
      rules TEXT,
      welcome_enabled TINYINT DEFAULT 1,
      antispam_enabled TINYINT DEFAULT 1,
      captcha_enabled TINYINT DEFAULT 1,
      force_join_enabled TINYINT DEFAULT 0,
      force_join_channel VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      chat_id BIGINT,
      user_id BIGINT,
      role VARCHAR(50),
      PRIMARY KEY (chat_id, user_id)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warns (
      chat_id BIGINT,
      user_id BIGINT,
      count INT DEFAULT 0,
      last_reason TEXT,
      PRIMARY KEY (chat_id, user_id)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mutes (
      chat_id BIGINT,
      user_id BIGINT,
      until_ts BIGINT,
      PRIMARY KEY (chat_id, user_id)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chat_id BIGINT,
      actor_id BIGINT,
      action VARCHAR(50),
      target_id BIGINT,
      reason TEXT,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      ref_user_id BIGINT,
      new_user_id BIGINT,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
}
await migrate()

// ---------- STATEMENTS ----------
async function upsertGroup({ chat_id, title, emperor_id, force_join_enabled, force_join_channel }) {
  await pool.query(
    `
    INSERT INTO chat_groups (chat_id, title, emperor_id, force_join_enabled, force_join_channel)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE title=VALUES(title), updated_at=CURRENT_TIMESTAMP
  `,
    [chat_id, title, emperor_id, force_join_enabled, force_join_channel]
  )
}

async function setEmperor(chat_id, emperor_id) {
  await pool.query(
    `UPDATE chat_groups SET emperor_id=?, updated_at=CURRENT_TIMESTAMP WHERE chat_id=?`,
    [emperor_id, chat_id]
  )
}

async function getGroup(chat_id) {
  const [rows] = await pool.query(`SELECT * FROM chat_groups WHERE chat_id=?`, [chat_id])
  return rows[0]
}

async function setCfg({ chat_id, rules, welcome_enabled, antispam_enabled, captcha_enabled, force_join_enabled, force_join_channel }) {
  await pool.query(
    `
    UPDATE chat_groups SET 
      rules=?, welcome_enabled=?, antispam_enabled=?, captcha_enabled=?, force_join_enabled=?, force_join_channel=?, updated_at=CURRENT_TIMESTAMP
    WHERE chat_id=?
  `,
    [rules, welcome_enabled, antispam_enabled, captcha_enabled, force_join_enabled, force_join_channel, chat_id]
  )
}

async function getRole(chat_id, user_id) {
  const [rows] = await pool.query(`SELECT role FROM roles WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
  return rows[0]?.role
}

async function setRole(chat_id, user_id, role) {
  await pool.query(
    `
    INSERT INTO roles(chat_id,user_id,role) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE role=VALUES(role)
  `,
    [chat_id, user_id, role]
  )
}

async function delRole(chat_id, user_id) {
  await pool.query(`DELETE FROM roles WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
}

async function getWarnCount(chat_id, user_id) {
  const [rows] = await pool.query(`SELECT count FROM warns WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
  return rows[0]?.count || 0
}

async function setWarnCount(chat_id, user_id, count, last_reason) {
  await pool.query(
    `
    INSERT INTO warns(chat_id,user_id,count,last_reason) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE count=VALUES(count), last_reason=VALUES(last_reason)
  `,
    [chat_id, user_id, count, last_reason]
  )
}

async function resetWarn(chat_id, user_id) {
  await pool.query(`DELETE FROM warns WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
}

async function setMute(chat_id, user_id, until_ts) {
  await pool.query(
    `
    INSERT INTO mutes(chat_id,user_id,until_ts) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE until_ts=VALUES(until_ts)
  `,
    [chat_id, user_id, until_ts]
  )
}

async function delMute(chat_id, user_id) {
  await pool.query(`DELETE FROM mutes WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
}

async function logAudit(chat_id, actor_id, action, target_id, reason) {
  await pool.query(
    `INSERT INTO audit(chat_id,actor_id,action,target_id,reason) VALUES (?,?,?,?,?)`,
    [chat_id, actor_id, action, target_id, reason]
  )
}

// ---------- ROLES & PERMISSIONS ----------
const Roles = {
  EMPEROR: 'emperor',
  QUEEN: 'queen',
  CONSUL: 'consul',
  KNIGHT: 'knight',
  PRINCE: 'prince',
  PRINCESS: 'princess',
  DUKE: 'duke',
  BARON: 'baron',
  CITIZEN: 'citizen'
}

const RoleLabelsFA = {
  emperor: '👑 امپراتور', queen: '👸 ملکه', consul: '👮 کنسول',
  knight: '⚔️ شوالیه', prince: '🤴 شاهزاده', princess: '👸 پرنسس',
  duke: '🎖 دوک', baron: '🏵 بارون', citizen: '👥 شهروند'
}
const RoleLabelsEN = {
  emperor: 'Emperor', queen: 'Queen', consul: 'Consul',
  knight: 'Knight', prince: 'Prince', princess: 'Princess',
  duke: 'Duke', baron: 'Baron', citizen: 'Citizen'
}

const HIERARCHY = [Roles.CITIZEN, Roles.BARON, Roles.DUKE, Roles.PRINCESS, Roles.PRINCE, Roles.KNIGHT, Roles.CONSUL, Roles.QUEEN, Roles.EMPEROR]
function roleRank(role) { return Math.max(0, HIERARCHY.indexOf(role || Roles.CITIZEN)) }

async function getActorRole(ctx, userId) {
  const g = await getGroup(ctx.chat.id)
  if (g?.emperor_id === userId) return Roles.EMPEROR

  const stored = await getRole(ctx.chat.id, userId)
  if (stored === Roles.QUEEN) return Roles.QUEEN

  try {
    const m = await ctx.getChatMember(userId)
    if (['creator', 'administrator'].includes(m.status)) return Roles.CONSUL
  } catch {}
  return stored || Roles.CITIZEN
}

function canAct(actorRole, targetRole, allowEqual = false) {
  if (!targetRole) targetRole = Roles.CITIZEN
  if (actorRole === Roles.EMPEROR || actorRole === Roles.QUEEN) return true
  const a = roleRank(actorRole)
  const b = roleRank(targetRole)
  return allowEqual ? a >= b : a > b
}

// ---------- KEYWORDS (FA/EN) ----------
const KW = {
  ban: [/\bban\b/i, /تبعید/i],
  unban: [/\bunban\b/i, /آزاد(?:\s|)سازی|رفع\s?بن|رفع\s?تبعید/i],
  mute: [/\bmute\b/i, /سکوت|میوت/i],
  unmute: [/\bunmute\b/i, /رفع\s?سکوت|آزاد\s?از\s?سکوت/i],
  warn: [/\bwarn\b/i, /اخطار/i],
  unwarn: [/\bunwarn\b/i, /حذف\s?اخطار|ریست\s?اخطار/i],
  purge: [/\bpurge\b/i, /پاکسازی|پاک\s?کردن/i],
  panel: [/\bpanel\b/i, /پنل/i],
  rules: [/\brules\b/i, /قوانین/i],
  setrules: [/\bset\s?rules\b/i, /تنظیم\s?قوانین/i],
  promote: [/\bpromote\b/i, /ارتقا|تنظیم/i],
  demote: [/\bdemote\b/i, /تنزل|کاهش\s?رتبه/i]
}

const ROLE_KW = {
  [Roles.QUEEN]: [/\bqueen\b/i, /ملکه/i],
  [Roles.KNIGHT]: [/\bknight\b/i, /شوالیه/i],
  [Roles.PRINCE]: [/\bprince\b/i, /شاهزاده/i],
  [Roles.PRINCESS]: [/\bprince(?:ss)?\b/i, /پرنسس/i],
  [Roles.DUKE]: [/\bduke\b/i, /دوک/i],
  [Roles.BARON]: [/\bbaron\b/i, /بارون/i],
  [Roles.CITIZEN]: [/\bcitizen\b/i, /شهروند/i]
}

function matchAny(text, regexArr) { return regexArr.some(r => r.test(text)) }

// ---------- HELPERS ----------
async function detectEmperor(ctx) {
  const admins = await ctx.getChatAdministrators()
  const creator = admins.find(a => a.status === 'creator')
  if (creator) await setEmperor(ctx.chat.id, creator.user.id)
  return creator?.user
}

function parseDuration(str) {
  if (!str) return null
  if (!/^\d+[smhd]$/i.test(str)) return null
  const n = parseInt(str)
  const u = str.slice(-1).toLowerCase()
  const mul = u === 's' ? 1e3 : u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3
  return n * mul
}

async function safeRestrict(ctx, userId, perms, untilDateSec) {
  try {
    await ctx.restrictChatMember(userId, { permissions: perms, until_date: untilDateSec })
  } catch (e) {
    try { await ctx.reply('⚠️ ' + (e.description || e.message)) } catch {}
  }
}

async function safeBan(ctx, userId) {
  try { await ctx.banChatMember(userId) } catch (e) {
    try { await ctx.reply('⚠️ ' + (e.description || e.message)) } catch {}
  }
}
async function safeUnban(ctx, userId) { try { await ctx.unbanChatMember(userId) } catch {} }

function human(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), r = s % 60
  if (m < 60) return `${m}m${r ? `${r}s` : ''}`
  const h = Math.floor(m / 60), mr = m % 60
  if (h < 24) return `${h}h${mr ? `${mr}m` : ''}`
  const d = Math.floor(h / 24), hr = h % 24
  return `${d}d${hr ? `${hr}h` : ''}`
}

function extractArgs(text) {
  const parts = text.trim().split(/\s+/)
  const dur = parts.find(p => /^\d+[smhd]$/i.test(p))
  const reason = text.replace(/\s*\d+[smhd]\s*/i, '').trim()
  return { dur, reason }
}

// ---------- STATE ----------
const spamMap = new Map() // key: chat:user => { last, count, ts }

// ---------- START ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return
  const ref = ctx.startPayload?.match(/^ref_(\d+)$/)?.[1]
  if (ref) {
    try { await pool.query(`INSERT INTO referrals(ref_user_id,new_user_id) VALUES (?,?)`, [+ref, ctx.from.id]) } catch {}
  }
  return ctx.reply(
    'سلام! من «امپراتور گروه» هستم 👑\nAdd me to a group and promote to admin.\n— Actions in groups are keyword-based (no / commands).\n— Reply to a user and say: "ban" / "تبعید", "mute 10m" / "سکوت ۱۰m", etc.',
    Markup.inlineKeyboard([[Markup.button.url('➕ Add to Group', 'https://t.me/' + ctx.me + '?startgroup=true')]])
  )
})

// ---------- CHAT MEMBER UPDATES ----------
bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status
  if (['administrator', 'member'].includes(status)) {
    await upsertGroup({
      chat_id: ctx.chat.id,
      title: ctx.chat.title || '',
      emperor_id: null,
      force_join_enabled: FORCE_JOIN ? 1 : 0,
      force_join_channel: FORCE_JOIN
    })
    const emp = await detectEmperor(ctx)
    await ctx.reply(`امپراتوری فعال شد.${emp ? ' 👑 ' + (emp.first_name) : ''}\n— دستورات: ریپلای کن و بگو «تبعید/ban», «سکوت/mute 10m», «اخطار/warn», «ارتقا شوالیه/promote knight» و...`)
  }
})

// ---------- ANTI-SPAM, CAPTCHA, FORCE-JOIN ----------
bot.on(message('new_chat_members'), async (ctx) => {
  const g = await getGroup(ctx.chat.id)
  if (!g) return
  for (const m of ctx.message.new_chat_members) {
    if (g.welcome_enabled) await ctx.reply(`🏛 خوش آمدی ${m.first_name}!`)
    if (g.force_join_enabled && g.force_join_channel) {
      try { await ctx.restrictChatMember(m.id, { permissions: { can_send_messages: false } }) } catch {}
      await ctx.replyWithMarkdown(
        `برای دسترسی، عضو ${g.force_join_channel} شو و سپس روی *تأیید عضویت* بزن.`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ تأیید عضویت', 'fj:' + m.id)]])
      )
    } else if (g.captcha_enabled) {
      try { await ctx.restrictChatMember(m.id, { permissions: { can_send_messages: false } }) } catch {}
      await ctx.reply(
        `برای اثبات انسان بودن ظرف ${CAPTCHA_TIMEOUT_SEC}s روی دکمه بزن.`,
        Markup.inlineKeyboard([[Markup.button.callback('من ربات نیستم 🤖❌', 'cap:' + m.id)]])
      )
      setTimeout(async () => {
        try {
          const member = await ctx.getChatMember(m.id)
          if (member && ['restricted'].includes(member.status)) await safeBan(ctx, m.id)
        } catch {}
      }, CAPTCHA_TIMEOUT_SEC * 1000)
    }
  }
})

bot.action(/fj:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery()
  const uid = +ctx.match[1]
  if (ctx.from.id !== uid) return ctx.reply('فقط همان کاربر می‌تواند تأیید کند.')
  const g = await getGroup(ctx.chat.id)
  if (!g?.force_join_channel) return
  try {
    const member = await ctx.telegram.getChatMember(g.force_join_channel, uid)
    if (['member', 'administrator', 'creator'].includes(member.status)) {
      await safeRestrict(ctx, uid, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_add_web_page_previews: true,
        can_send_other_messages: true
      }, 0)
      await ctx.reply('✅ تأیید شد. خوش آمدی!')
    } else {
      await ctx.reply('هنوز عضو کانال نیستی.')
    }
  } catch {
    await ctx.reply('ابتدا وارد کانال شو، بعد دوباره امتحان کن.')
  }
})

bot.action(/cap:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('Verified')
  const uid = +ctx.match[1]
  if (ctx.from.id !== uid) return ctx.reply('این دکمه مخصوص شخص دیگری است.')
  await safeRestrict(ctx, uid, {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_add_web_page_previews: true,
    can_send_other_messages: true
  }, 0)
  await ctx.reply('✅ خوش آمدی!')
})

// ---------- TEXT HANDLER ----------
bot.on(message('text'), async (ctx) => {
  const g = await getGroup(ctx.chat.id)
  if (!g) return

  // Anti-spam: repeat & links
  if (g.antispam_enabled) {
    const key = `${ctx.chat.id}:${ctx.from.id}`
    const mem = spamMap.get(key) || { last: '', count: 0, ts: 0 }
    const now = Date.now()
    if (ctx.message.text === mem.last && now - mem.ts < 6000) mem.count++
    else { mem.count = 1; mem.last = ctx.message.text }
    mem.ts = now; spamMap.set(key, mem)
    if (mem.count >= 4) {
      const until = Math.floor((Date.now() + 2 * 60 * 1000) / 1000)
      await safeRestrict(ctx, ctx.from.id, { can_send_messages: false }, until)
      await setMute(ctx.chat.id, ctx.from.id, until)
      await logAudit(ctx.chat.id, ctx.from.id, 'auto-mute', ctx.from.id, 'flood')
      await ctx.reply('🔇 به‌خاطر اسپم ۲ دقیقه سکوت شد.')
      return
    }
    if (/(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(ctx.message.text)) {
      try { await ctx.deleteMessage() } catch {}
      const c = await getWarnCount(ctx.chat.id, ctx.from.id)
      const next = c + 1
      await setWarnCount(ctx.chat.id, ctx.from.id, next, 'link')
      if (next >= 3) {
        await safeBan(ctx, ctx.from.id)
        await resetWarn(ctx.chat.id, ctx.from.id)
        await ctx.reply('🚫 تبعید به‌خاطر لینک/اسپم.')
      } else {
        await ctx.reply(`⚠️ ارسال لینک ممنوع. اخطار ${next}/3`)
      }
      return
    }
  }

  const text = ctx.message.text.trim()
  const replyTo = ctx.message.reply_to_message
  const actorId = ctx.from.id
  const actorRole = await getActorRole(ctx, actorId)

  // Inline panel
  if (matchAny(text, KW.panel)) {
    const isBoss = [Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)
    if (!isBoss) return
    const g2 = await getGroup(ctx.chat.id)
    return ctx.reply('🛡 پنل مدیریت امپراتوری', Markup.inlineKeyboard([
      [Markup.button.callback(g2.antispam_enabled ? 'ضداسپم: روشن ✅' : 'ضداسپم: خاموش ❌', 'cfg:antispam')],
      [Markup.button.callback(g2.welcome_enabled ? 'خوشامد: روشن ✅' : 'خوشامد: خاموش ❌', 'cfg:welcome')],
      [Markup.button.callback(g2.captcha_enabled ? 'کپچا: روشن ✅' : 'کپچا: خاموش ❌', 'cfg:captcha')],
      [Markup.button.callback(g2.force_join_enabled ? 'اجبار عضویت: روشن ✅' : 'اجبار عضویت: خاموش ❌', 'cfg:fj')]
    ]))
  }

  // Rules show/set
  if (matchAny(text, KW.rules)) {
    if (!g.rules) return ctx.reply('📜 قانونی ثبت نشده.')
    return ctx.reply('📜 قوانین:\n' + g.rules)
  }
  if (matchAny(text, KW.setrules)) {
    if (![Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)) return
    const rulesText = text.replace(/^(set\s?rules|تنظیم\s?قوانین)/i, '').trim()
    await setCfg({
      chat_id: ctx.chat.id,
      rules: rulesText,
      welcome_enabled: g.welcome_enabled,
      antispam_enabled: g.antispam_enabled,
      captcha_enabled: g.captcha_enabled,
      force_join_enabled: g.force_join_enabled,
      force_join_channel: g.force_join_channel
    })
    return ctx.reply('📜 قوانین به‌روزرسانی شد.')
  }

  // Moderation actions require a replied target
  if (!replyTo) return
  const target = replyTo.from
  const targetRole = await getActorRole(ctx, target.id)

  // PROMOTE / DEMOTE
  if (matchAny(text, KW.promote)) {
    if (![Roles.EMPEROR, Roles.QUEEN].includes(actorRole)) return ctx.reply('فقط امپراتور/ملکه.')
    const role = Object.keys(ROLE_KW).find(r => matchAny(text, ROLE_KW[r]))
    if (!role) return ctx.reply('نقش پیدا نشد. مثال: "promote knight" / "تنظیم شوالیه"')
    if (!canAct(actorRole, targetRole, true)) return ctx.reply('اجازه نداری روی رتبهٔ برابر/بالاتر اعمال کنی.')
    await setRole(ctx.chat.id, target.id, role)
    return ctx.reply(`✅ ارتقا: ${target.first_name} → ${RoleLabelsFA[role]} (${RoleLabelsEN[role]})`)
  }

  if (matchAny(text, KW.demote)) {
    if (![Roles.EMPEROR, Roles.QUEEN].includes(actorRole)) return
    if (!canAct(actorRole, targetRole, false)) return ctx.reply('اجازه نداری.')
    await delRole(ctx.chat.id, target.id)
    return ctx.reply(`✅ تنزل: ${target.first_name} → ${RoleLabelsFA[Roles.CITIZEN]}`)
  }

  // BAN / UNBAN
  if (matchAny(text, KW.ban)) {
    if (!canAct(actorRole, targetRole)) return ctx.reply('اجازهٔ تبعید این کاربر را نداری.')
    await safeBan(ctx, target.id)
    await logAudit(ctx.chat.id, actorId, 'ban', target.id, '-')
    return ctx.reply(`🚫 تبعید شد: ${target.first_name}`)
  }
  if (matchAny(text, KW.unban)) {
    if (![Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)) return
    await safeUnban(ctx, target.id)
    await logAudit(ctx.chat.id, actorId, 'unban', target.id, '-')
    return ctx.reply(`✅ رفع تبعید: ${target.first_name}`)
  }

  // MUTE / UNMUTE
  if (matchAny(text, KW.mute)) {
    if (!canAct(actorRole, targetRole)) return ctx.reply('اجازه نداری.')
    const { dur } = extractArgs(text)
    const ms = dur ? parseDuration(dur) : 10 * 60 * 1000
    const until = Math.floor((Date.now() + ms) / 1000)
    await safeRestrict(ctx, target.id, { can_send_messages: false }, until)
    await setMute(ctx.chat.id, target.id, until)
    await logAudit(ctx.chat.id, actorId, 'mute', target.id, '-')
    return ctx.reply(`🔇 سکوت ${target.first_name} تا ${human(ms)}`)
  }
  if (matchAny(text, KW.unmute)) {
    if (![Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)) return
    await safeRestrict(ctx, target.id, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_add_web_page_previews: true,
      can_send_other_messages: true
    }, 0)
    await delMute(ctx.chat.id, target.id)
    await logAudit(ctx.chat.id, actorId, 'unmute', target.id, '-')
    return ctx.reply(`🔊 رفع سکوت: ${target.first_name}`)
  }

  // WARN / UNWARN
  if (matchAny(text, KW.warn)) {
    if (!canAct(actorRole, targetRole)) return ctx.reply('اجازه نداری.')
    const c = await getWarnCount(ctx.chat.id, target.id)
    const next = c + 1
    await setWarnCount(ctx.chat.id, target.id, next, '-')
    await logAudit(ctx.chat.id, actorId, 'warn', target.id, '-')
    if (next >= 3) {
      await safeBan(ctx, target.id)
      await resetWarn(ctx.chat.id, target.id)
      return ctx.reply('🚫 ۳ اخطار → تبعید شد.')
    }
    return ctx.reply(`⚠️ اخطار ${next}/3 برای ${target.first_name}`)
  }
  if (matchAny(text, KW.unwarn)) {
    if (![Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)) return
    await resetWarn(ctx.chat.id, target.id)
    await logAudit(ctx.chat.id, actorId, 'unwarn', target.id, '-')
    return ctx.reply('✅ اخطارها ریست شد.')
  }

  // PURGE
  if (matchAny(text, KW.purge)) {
    if (![Roles.EMPEROR, Roles.QUEEN, Roles.CONSUL].includes(actorRole)) return
    try {
      const fromId = replyTo.message_id
      const toId = ctx.message.message_id
      for (let mid = fromId; mid <= toId; mid++) {
        // هر پیام ممکنه پاک نشه؛ ادامه بده
        // eslint-disable-next-line no-await-in-loop
        await ctx.deleteMessage(mid).catch(() => {})
      }
      await logAudit(ctx.chat.id, actorId, 'purge', 0, '-')
    } catch (e) { await ctx.reply('پاکسازی ناموفق.') }
  }
})

// ---------- INLINE CONFIG TOGGLES ----------
bot.action('cfg:antispam', async (ctx) => {
  await ctx.answerCbQuery()
  const g = await getGroup(ctx.chat.id)
  const val = g.antispam_enabled ? 0 : 1
  await setCfg({ chat_id: ctx.chat.id, rules: g.rules, welcome_enabled: g.welcome_enabled, antispam_enabled: val, captcha_enabled: g.captcha_enabled, force_join_enabled: g.force_join_enabled, force_join_channel: g.force_join_channel })
  await ctx.editMessageText(val ? 'ضداسپم: روشن ✅' : 'ضداسپم: خاموش ❌')
})

bot.action('cfg:welcome', async (ctx) => {
  await ctx.answerCbQuery()
  const g = await getGroup(ctx.chat.id)
  const val = g.welcome_enabled ? 0 : 1
  await setCfg({ chat_id: ctx.chat.id, rules: g.rules, welcome_enabled: val, antispam_enabled: g.antispam_enabled, captcha_enabled: g.captcha_enabled, force_join_enabled: g.force_join_enabled, force_join_channel: g.force_join_channel })
  await ctx.editMessageText(val ? 'خوشامد: روشن ✅' : 'خوشامد: خاموش ❌')
})

bot.action('cfg:captcha', async (ctx) => {
  await ctx.answerCbQuery()
  const g = await getGroup(ctx.chat.id)
  const val = g.captcha_enabled ? 0 : 1
  await setCfg({ chat_id: ctx.chat.id, rules: g.rules, welcome_enabled: g.welcome_enabled, antispam_enabled: g.antispam_enabled, captcha_enabled: val, force_join_enabled: g.force_join_enabled, force_join_channel: g.force_join_channel })
  await ctx.editMessageText(val ? 'کپچا: روشن ✅' : 'کپچا: خاموش ❌')
})

bot.action('cfg:fj', async (ctx) => {
  await ctx.answerCbQuery()
  const g = await getGroup(ctx.chat.id)
  const val = g.force_join_enabled ? 0 : 1
  await setCfg({ chat_id: ctx.chat.id, rules: g.rules, welcome_enabled: g.welcome_enabled, antispam_enabled: g.antispam_enabled, captcha_enabled: g.captcha_enabled, force_join_enabled: val, force_join_channel: FORCE_JOIN || g.force_join_channel })
  await ctx.editMessageText(val ? 'اجبار عضویت: روشن ✅' : 'اجبار عضویت: خاموش ❌')
})

// ---------- ERROR & LAUNCH ----------
bot.catch((err, ctx) => { console.error('Bot error', err); try { ctx?.reply?.('⚠️ خطای داخلی.') } catch {} })

// Webhook server
const app = express()

app.get('/', (req, res) => {
  res.send('🤖 Bot is running...')
})

// MUST be before listen
app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`))

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`)
  if (!WEBHOOK_URL) {
    console.error('⚠️ WEBHOOK_URL is missing in .env')
    return
  }
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`)
    console.log('✅ Webhook set')
  } catch (e) {
    console.error('❌ setWebhook failed:', e)
  }
})
