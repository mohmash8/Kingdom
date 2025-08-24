// index.mjs
// Emperor Group Manager Bot – "Imperial Ultra" 👑
// Fixed: preserve emperor_id, prevent self-promote/demote, protect emperor from regular mod commands
import 'dotenv/config'
import express from 'express'
import { Telegraf, Markup } from 'telegraf'
import { message } from 'telegraf/filters'
import mysql from 'mysql2/promise'

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env')

const WEBHOOK_URL = process.env.WEBHOOK_URL // e.g. https://example.com
const PORT = +(process.env.PORT || 8080)
const FORCE_JOIN = process.env.FORCE_JOIN || '' // e.g. @its4_Four (empty to disable)
const CAPTCHA_TIMEOUT_SEC = +(process.env.CAPTCHA_TIMEOUT_SEC || 120)
const TAG_MAX_MENTIONS = +(process.env.TAG_MAX_MENTIONS || 20)

// ---------- BOT & DB ----------
console.log('Bot starting...')
console.log('BOT_TOKEN:', !!BOT_TOKEN)

const bot = new Telegraf(BOT_TOKEN)

const pool = await mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
})

try { await pool.query('SELECT 1'); console.log('✅ Connected to MySQL') } catch (err) { console.error('❌ DB error:', err) }

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recent_users (
      chat_id BIGINT,
      user_id BIGINT,
      first_name VARCHAR(255),
      username VARCHAR(255),
      last_seen BIGINT,
      PRIMARY KEY (chat_id, user_id)
    );
  `)
}
await migrate()

// ---------- DB HELPERS ----------
async function upsertGroup({ chat_id, title, emperor_id, force_join_enabled, force_join_channel }) {
  // Backwards-compatible safe upsert: only update emperor_id when explicitly provided
  if (typeof emperor_id === 'undefined' || emperor_id === null) {
    await pool.query(
      `INSERT INTO chat_groups (chat_id, title, force_join_enabled, force_join_channel)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title=VALUES(title), force_join_enabled=VALUES(force_join_enabled), force_join_channel=VALUES(force_join_channel), updated_at=CURRENT_TIMESTAMP`,
      [chat_id, title, force_join_enabled, force_join_channel]
    )
  } else {
    await pool.query(
      `INSERT INTO chat_groups (chat_id, title, emperor_id, force_join_enabled, force_join_channel)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title=VALUES(title), emperor_id=VALUES(emperor_id), force_join_enabled=VALUES(force_join_enabled), force_join_channel=VALUES(force_join_channel), updated_at=CURRENT_TIMESTAMP`,
      [chat_id, title, emperor_id, force_join_enabled, force_join_channel]
    )
  }
}

async function setEmperor(chat_id, emperor_id) {
  await pool.query(`UPDATE chat_groups SET emperor_id=?, updated_at=CURRENT_TIMESTAMP WHERE chat_id=?`, [emperor_id, chat_id])
}

async function getGroup(chat_id) {
  const [rows] = await pool.query(`SELECT * FROM chat_groups WHERE chat_id=?`, [chat_id])
  return rows[0]
}

async function setCfg({ chat_id, rules, welcome_enabled, antispam_enabled, captcha_enabled, force_join_enabled, force_join_channel }) {
  await pool.query(
    `UPDATE chat_groups SET 
      rules=?, welcome_enabled=?, antispam_enabled=?, captcha_enabled=?, force_join_enabled=?, force_join_channel=?, updated_at=CURRENT_TIMESTAMP
    WHERE chat_id=?`,
    [rules, welcome_enabled, antispam_enabled, captcha_enabled, force_join_enabled, force_join_channel, chat_id]
  )
}

async function getRole(chat_id, user_id) {
  const [rows] = await pool.query(`SELECT role FROM roles WHERE chat_id=? AND user_id=?`, [chat_id, user_id])
  return rows[0]?.role
}

async function setRole(chat_id, user_id, role) {
  await pool.query(
    `INSERT INTO roles(chat_id,user_id,role) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE role=VALUES(role)`,
    [chat_id, user_id, role]
  )
}

// Safe wrapper to prevent changing emperor via normal DB helper
async function setRoleSafe(chat_id, user_id, role) {
  const g = await getGroup(chat_id)
  if (g?.emperor_id === user_id) throw new Error('cannot_change_emperor_role')
  await setRole(chat_id, user_id, role)
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
    `INSERT INTO warns(chat_id,user_id,count,last_reason) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE count=VALUES(count), last_reason=VALUES(last_reason)`,
    [chat_id, user_id, count, last_reason]
  )
}
async function resetWarn(chat_id, user_id) { await pool.query(`DELETE FROM warns WHERE chat_id=? AND user_id=?`, [chat_id, user_id]) }
async function setMute(chat_id, user_id, until_ts) {
  await pool.query(
    `INSERT INTO mutes(chat_id,user_id,until_ts) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE until_ts=VALUES(until_ts)`,
    [chat_id, user_id, until_ts]
  )
}
async function delMute(chat_id, user_id) { await pool.query(`DELETE FROM mutes WHERE chat_id=? AND user_id=?`, [chat_id, user_id]) }
async function logAudit(chat_id, actor_id, action, target_id, reason) {
  await pool.query(`INSERT INTO audit(chat_id,actor_id,action,target_id,reason) VALUES (?,?,?,?,?)`, [chat_id, actor_id, action, target_id, reason])
}
async function touchRecentUser(chat_id, u) {
  const { id, first_name, username } = u
  await pool.query(
    `INSERT INTO recent_users(chat_id,user_id,first_name,username,last_seen) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE first_name=VALUES(first_name), username=VALUES(username), last_seen=VALUES(last_seen)`,
    [chat_id, id, first_name || '', username || '', Date.now()]
  )
}
async function getRecentUsers(chat_id, limit) {
  const [rows] = await pool.query(`SELECT * FROM recent_users WHERE chat_id=? ORDER BY last_seen DESC LIMIT ?`, [chat_id, limit])
  return rows
}

// ---------- ROLES & PERMISSIONS ----------
const Roles = Object.freeze({
  KING: 'king',
  QUEEN: 'queen',
  KNIGHT: 'knight',
  PRINCE: 'prince',
  PRINCESS: 'princess',
  SOLDIER: 'soldier'
})
const RoleLabelsFA = Object.freeze({
  king: '👑 پادشاه',
  queen: '👸 ملکه',
  knight: '⚔️ شوالیه',
  prince: '🤴 شاهزاده',
  princess: '👸 پرنسس',
  soldier: '🛡 سرباز'
})
const HIERARCHY = [Roles.SOLDIER, Roles.PRINCESS, Roles.PRINCE, Roles.KNIGHT, Roles.QUEEN, Roles.KING]
const roleRank = (role) => Math.max(0, HIERARCHY.indexOf(role || Roles.SOLDIER))

const Cap = Object.freeze({ BAN:'ban', UNBAN:'unban', MUTE:'mute', UNMUTE:'unmute', WARN:'warn', UNWARN:'unwarn', PURGE:'purge', PROMOTE:'promote', DEMOTE:'demote', PANEL:'panel', RULES:'rules', TAG:'tag' })
const CAP_MATRIX = {
  [Roles.KING]: new Set(Object.values(Cap)),
  [Roles.QUEEN]: new Set(Object.values(Cap)),
  [Roles.KNIGHT]: new Set([Cap.BAN, Cap.UNBAN, Cap.MUTE, Cap.UNMUTE, Cap.WARN, Cap.UNWARN, Cap.PURGE, Cap.RULES, Cap.TAG]),
  [Roles.PRINCE]: new Set([Cap.MUTE, Cap.UNMUTE, Cap.WARN, Cap.RULES, Cap.TAG]),
  [Roles.PRINCESS]: new Set([Cap.MUTE, Cap.WARN, Cap.RULES, Cap.TAG]),
  [Roles.SOLDIER]: new Set([Cap.RULES, Cap.TAG])
}
function canUse(actorRole, capability) {
  const set = CAP_MATRIX[actorRole] || CAP_MATRIX[Roles.SOLDIER]
  return set.has(capability)
}
function canActOn(actorRole, targetRole, allowEqual = false) {
  if ([Roles.KING, Roles.QUEEN].includes(actorRole)) return true
  const a = roleRank(actorRole)
  const b = roleRank(targetRole || Roles.SOLDIER)
  return allowEqual ? a >= b : a > b
}

// ---------- KEYWORDS ----------
const KW = {
  ban: [/\bban\b/i, /تبعید/i],
  unban: [/\bunban\b/i, /رفع\s?(?:بن|تبعید)/i],
  mute: [/\bmute\b/i, /سکوت|میوت/i],
  unmute: [/\bunmute\b/i, /رفع\s?سکوت/i],
  warn: [/\bwarn\b/i, /اخطار/i],
  unwarn: [/\bunwarn\b/i, /حذف\s?اخطار|ریست\s?اخطار/i],
  purge: [/\bpurge\b/i, /پاکسازی|پاک\s?کردن/i],
  panel: [/\bpanel\b/i, /پنل/i],
  rules: [/\brules\b/i, /قوانین/i],
  setrules: [/\bset\s?rules\b/i, /تنظیم\s?قوانین/i],
  promote: [/\bpromote\b/i, /ارتقا|تنظیم/i],
  demote: [/\bdemote\b/i, /تنزل|کاهش\s?رتبه/i],
  tag: [/\btag\b/i, /تگ/i]
}
const ROLE_KW = {
  [Roles.QUEEN]: [/\bqueen\b/i, /ملکه/i],
  [Roles.KNIGHT]: [/\bknight\b/i, /شوالیه/i],
  [Roles.PRINCE]: [/\bprince\b/i, /شاهزاده/i],
  [Roles.PRINCESS]: [/\bprincess\b/i, /پرنسس/i],
  [Roles.SOLDIER]: [/\bsoldier\b/i, /سرباز/i]
}
const matchAny = (text, regexArr) => regexArr.some(r => r.test(text))

// ---------- UTIL ----------
async function detectEmperor(ctx) {
  try {
    const admins = await ctx.getChatAdministrators()
    const creator = admins.find(a => a.status === 'creator')
    if (creator) {
      // only set emperor if not already set
      const g = await getGroup(ctx.chat.id)
      if (!g?.emperor_id) await setEmperor(ctx.chat.id, creator.user.id)
      return creator.user
    }
  } catch (e) {
    // ignore
  }
  return null
}
function parseDuration(str) {
  if (!str) return null
  if (!/^\d+[smhd]$/i.test(str)) return null
  const n = parseInt(str)
  const u = str.slice(-1).toLowerCase()
  const mul = u === 's' ? 1e3 : u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3
  return n * mul
}
async function isAdmin(ctx, userId) {
  try { const m = await ctx.getChatMember(userId); return ['creator','administrator'].includes(m.status) } catch { return false }
}
async function getUserRole(ctx, userId) {
  const g = await getGroup(ctx.chat.id)
  if (g?.emperor_id === userId) return Roles.KING
  const stored = await getRole(ctx.chat.id, userId)
  if (stored === Roles.QUEEN) return Roles.QUEEN
  if (await isAdmin(ctx, userId)) return Roles.KNIGHT
  return stored || Roles.SOLDIER
}
async function safeRestrict(ctx, userId, perms, untilDateSec) {
  try { await ctx.restrictChatMember(userId, { permissions: perms, until_date: untilDateSec }); return true } catch (e) { await safeReply(ctx, '⚠️ '+(e.description||e.message)); return false }
}
async function safeBan(ctx, userId) { try { await ctx.banChatMember(userId); return true } catch (e) { await safeReply(ctx, '⚠️ '+(e.description||e.message)); return false } }
async function safeUnban(ctx, userId) { try { await ctx.unbanChatMember(userId); return true } catch { return false } }
function human(ms) {
  const s = Math.floor(ms/1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s/60), r = s%60
  if (m < 60) return `${m}m${r?`${r}s`:''}`
  const h = Math.floor(m/60), mr = m%60
  if (h < 24) return `${h}h${mr?`${mr}m`:''}`
  const d = Math.floor(h/24), hr = h%24
  return `${d}d${hr?`${hr}h`:''}`
}
function extractArgs(text) { const parts = text.trim().split(/\s+/); const dur = parts.find(p => /^\d+[smhd]$/i.test(p)); const reason = text.replace(/\s*\d+[smhd]\s*/i, '').trim(); return { dur, reason } }
async function safeReply(ctx, text, extra = {}) { try { await ctx.reply(text, { reply_to_message_id: ctx.message?.message_id, allow_sending_without_reply: true, ...extra }) } catch {} }

// ---------- STATE ----------
const spamMap = new Map()

// ---------- START ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return
  const ref = ctx.startPayload?.match(/^ref_(\d+)$/)?.[1]
  if (ref) { try { await pool.query(`INSERT INTO referrals(ref_user_id,new_user_id) VALUES (?,?)`, [+ref, ctx.from.id]) } catch {} }
  return ctx.reply(
    'سلام! من «امپراتور گروه» هستم 👑\nمنیجمنت گروه با کلمات فارسی/انگلیسی و ریپلای.\n— نمونه: ریپلای کن و بگو: "تبعید" یا "ban"، "سکوت 10m"، "اخطار"، "ارتقا شوالیه" و ...',
    Markup.inlineKeyboard([[Markup.button.url('➕ افزودن به گروه', 'https://t.me/' + ctx.me + '?startgroup=true')]])
  )
})

// ---------- CHAT MEMBER UPDATES ----------
bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status
  if (['administrator','member'].includes(status)) {
    await upsertGroup({ chat_id: ctx.chat.id, title: ctx.chat.title || '', force_join_enabled: FORCE_JOIN ? 1 : 0, force_join_channel: FORCE_JOIN })
    const emp = await detectEmperor(ctx)
    await safeReply(ctx, `امپراتوری فعال شد.${emp ? ' 👑 ' + (emp.first_name) : ''}\n— ریپلای کن و بگو: «تبعید/ban»، «سکوت/mute 10m»، «اخطار/warn»، «ارتقا شوالیه/promote knight» و...`)
  }
})

// ---------- NEW MEMBERS ----------
bot.on(message('new_chat_members'), async (ctx) => {
  const g = await getGroup(ctx.chat.id)
  if (!g) return
  for (const m of ctx.message.new_chat_members) {
    if (g.welcome_enabled) await safeReply(ctx, `🏛 خوش آمدی ${m.first_name}!`)
    if (g.force_join_enabled && g.force_join_channel) {
      try { await ctx.restrictChatMember(m.id, { permissions: { can_send_messages: false } }) } catch {}
      await ctx.reply(`برای دسترسی، عضو ${g.force_join_channel} شو و سپس روی «تأیید عضویت» بزن.`, {
        reply_to_message_id: ctx.message.message_id,
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ تأیید عضویت', 'fj:'+m.id)]])
      })
    } else if (g.captcha_enabled) {
      try { await ctx.restrictChatMember(m.id, { permissions: { can_send_messages: false } }) } catch {}
      await ctx.reply(`برای اثبات انسان بودن ظرف ${CAPTCHA_TIMEOUT_SEC}s روی دکمه بزن.`, {
        reply_to_message_id: ctx.message.message_id,
        ...Markup.inlineKeyboard([[Markup.button.callback('من ربات نیستم 🤖❌', 'cap:'+m.id)]])
      })
      setTimeout(async () => {
        try {
          const member = await ctx.getChatMember(m.id)
          if (member && member.status === 'restricted') await safeBan(ctx, m.id)
        } catch {}
      }, CAPTCHA_TIMEOUT_SEC * 1000)
    }
  }
})

bot.action(/fj:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery()
  const uid = +ctx.match[1]
  if (ctx.from.id !== uid) return safeReply(ctx, 'فقط همان کاربر می‌تواند تأیید کند.')
  const g = await getGroup(ctx.chat.id)
  if (!g?.force_join_channel) return
  try {
    const member = await ctx.telegram.getChatMember(g.force_join_channel, uid)
    if (['member','administrator','creator'].includes(member.status)) {
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
      await safeReply(ctx, '✅ تأیید شد. خوش آمدی!')
    } else { await safeReply(ctx, 'هنوز عضو کانال نیستی.') }
  } catch { await safeReply(ctx, 'ابتدا وارد کانال شو، بعد دوباره امتحان کن.') }
})

bot.action(/cap:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('Verified')
  const uid = +ctx.match[1]
  if (ctx.from.id !== uid) return safeReply(ctx, 'این دکمه مخصوص شخص دیگری است.')
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
  await safeReply(ctx, '✅ خوش آمدی!')
})

// ---------- TEXT HANDLER ----------
bot.on(message('text'), async (ctx) => {
  const g = await getGroup(ctx.chat.id)
  if (!g) return

  await touchRecentUser(ctx.chat.id, ctx.from)

  if (g.antispam_enabled) {
    const key = `${ctx.chat.id}:${ctx.from.id}`
    const mem = spamMap.get(key) || { last:'', count:0, ts:0 }
    const now = Date.now()
    if (ctx.message.text === mem.last && now - mem.ts < 6000) mem.count++
    else { mem.count = 1; mem.last = ctx.message.text }
    mem.ts = now; spamMap.set(key, mem)
    if (mem.count >= 4) {
      const until = Math.floor((Date.now() + 2*60*1000)/1000)
      const ok = await safeRestrict(ctx, ctx.from.id, { can_send_messages: false }, until)
      if (ok) {
        await setMute(ctx.chat.id, ctx.from.id, until)
        await logAudit(ctx.chat.id, ctx.from.id, 'auto-mute', ctx.from.id, 'flood')
        await safeReply(ctx, '🔇 به‌خاطر اسپم ۲ دقیقه سکوت شد.')
        return
      }
    }
    if (/(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(ctx.message.text)) {
      try { await ctx.deleteMessage() } catch {}
      const c = await getWarnCount(ctx.chat.id, ctx.from.id)
      const next = c + 1
      await setWarnCount(ctx.chat.id, ctx.from.id, next, 'link')
      if (next >= 3) {
        const ok = await safeBan(ctx, ctx.from.id)
        if (ok) { await resetWarn(ctx.chat.id, ctx.from.id); await safeReply(ctx, '🚫 تبعید به‌خاطر لینک/اسپم.') }
      } else {
        await safeReply(ctx, `⚠️ ارسال لینک ممنوع. اخطار ${next}/3`)
      }
      return
    }
  }

  const text = ctx.message.text.trim()
  const replyTo = ctx.message.reply_to_message
  const actorId = ctx.from.id
  const actorRole = await getUserRole(ctx, actorId)

  // پنل
  if (matchAny(text, KW.panel)) {
    if (!canUse(actorRole, Cap.PANEL)) return
    const g2 = await getGroup(ctx.chat.id)
    return safeReply(ctx, '🛡 پنل مدیریت امپراتوری', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback(g2.antispam_enabled ? 'ضداسپم: روشن ✅' : 'ضداسپم: خاموش ❌', 'cfg:antispam')],
        [Markup.button.callback(g2.welcome_enabled ? 'خوشامد: روشن ✅' : 'خوشامد: خاموش ❌', 'cfg:welcome')],
        [Markup.button.callback(g2.captcha_enabled ? 'کپچا: روشن ✅' : 'کپچا: خاموش ❌', 'cfg:captcha')],
        [Markup.button.callback(g2.force_join_enabled ? 'اجبار عضویت: روشن ✅' : 'اجبار عضویت: خاموش ❌', 'cfg:fj')]
      ])
    })
  }

  // قوانین
  if (matchAny(text, KW.rules)) {
    if (!g.rules) return safeReply(ctx, '📜 قانونی ثبت نشده.')
    return safeReply(ctx, '📜 قوانین:\n' + g.rules)
  }
  if (matchAny(text, KW.setrules)) {
    if (!canUse(actorRole, Cap.RULES)) return
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
    return safeReply(ctx, '📜 قوانین به‌روزرسانی شد.')
  }

  // تگ
  if (matchAny(text, KW.tag)) {
    if (!canUse(actorRole, Cap.TAG)) return
    const n = Math.max(1, Math.min(TAG_MAX_MENTIONS, +text.split(/\s+/)[1] || 10))
    const users = await getRecentUsers(ctx.chat.id, n)
    if (!users.length) return safeReply(ctx, 'کسی برای تگ یافت نشد.')
    const mentions = users.map(u => {
      if (u.username) return `@${u.username}`
      return `[${u.first_name || 'کاربر'}](tg://user?id=${u.user_id})`
    }).join(' ')
    return ctx.reply(`📣 ${mentions}`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id })
  }

  // نیازمند ریپلای
  if (!replyTo) return
  if (replyTo?.from) await touchRecentUser(ctx.chat.id, replyTo.from)

  const target = replyTo.from
  const targetRole = await getUserRole(ctx, target.id)
  const targetIsAdmin = await isAdmin(ctx, target.id)

  // جلوگیری از انجام عملیات روی خود کاربر
  if (actorId === target.id) return safeReply(ctx, '⚠️ شما نمی‌توانید روی خودتان این عملیات را انجام دهید.')
  // محافظت از امپراتور
  if (g?.emperor_id && g.emperor_id === target.id) return safeReply(ctx, '⚠️ روی امپراتور نمی‌توان این عملیات را انجام داد.')

  // PROMOTE / DEMOTE
  if (matchAny(text, KW.promote)) {
    if (!canUse(actorRole, Cap.PROMOTE)) return safeReply(ctx, 'مجوز ارتقا نداری.')
    if (!canActOn(actorRole, targetRole, true)) return safeReply(ctx, 'اجازه نداری روی رتبهٔ برابر/بالاتر اعمال کنی.')
    const roleKey = Object.keys(ROLE_KW).find(r => matchAny(text, ROLE_KW[r]))
    if (!roleKey) return safeReply(ctx, 'نقش پیدا نشد. مثال: "promote knight" / "ارتقا شوالیه"')
    try {
      await setRoleSafe(ctx.chat.id, target.id, roleKey)
      return safeReply(ctx, `✅ ارتقا: ${target.first_name} → ${RoleLabelsFA[roleKey]}`)
    } catch (e) {
      if (e.message === 'cannot_change_emperor_role') return safeReply(ctx, '⚠️ نقش امپراتور را نمی‌توان از طریق این دستور تغییر داد.')
      return safeReply(ctx, '⚠️ خطا در تنظیم نقش.')
    }
  }

  if (matchAny(text, KW.demote)) {
    if (!canUse(actorRole, Cap.DEMOTE)) return safeReply(ctx, 'مجوز تنزل نداری.')
    if (!canActOn(actorRole, targetRole, false)) return safeReply(ctx, 'اجازه نداری.')
    // extra protection: cannot demote emperor
    if (g?.emperor_id && g.emperor_id === target.id) return safeReply(ctx, '⚠️ نمی‌توان امپراتور را تنزل داد.')
    await delRole(ctx.chat.id, target.id)
    return safeReply(ctx, `✅ تنزل: ${target.first_name} → ${RoleLabelsFA[Roles.SOLDIER]}`)
  }

  // BAN / UNBAN
  if (matchAny(text, KW.ban)) {
    if (!canUse(actorRole, Cap.BAN)) return safeReply(ctx, 'مجوز تبعید نداری.')
    if (!canActOn(actorRole, targetRole)) return safeReply(ctx, 'اجازهٔ تبعید این کاربر را نداری.')
    if (targetIsAdmin) return safeReply(ctx, '🚫 نمی‌توان ادمین/سازنده را تبعید کرد.')
    if (g?.emperor_id && g.emperor_id === target.id) return safeReply(ctx, '⚠️ روی امپراتور نمی‌توان این عملیات را انجام داد.')
    const ok = await safeBan(ctx, target.id)
    if (ok) { await logAudit(ctx.chat.id, actorId, 'ban', target.id, '-'); return safeReply(ctx, `🚫 تبعید شد: ${target.first_name}`) }
    return
  }
  if (matchAny(text, KW.unban)) {
    if (!canUse(actorRole, Cap.UNBAN)) return
    const ok = await safeUnban(ctx, target.id)
    if (ok) { await logAudit(ctx.chat.id, actorId, 'unban', target.id, '-'); return safeReply(ctx, `✅ رفع تبعید: ${target.first_name}`) }
    return
  }

  // MUTE / UNMUTE
  if (matchAny(text, KW.mute)) {
    if (!canUse(actorRole, Cap.MUTE)) return safeReply(ctx, 'مجوز سکوت نداری.')
    if (!canActOn(actorRole, targetRole)) return safeReply(ctx, 'اجازه نداری.')
    if (targetIsAdmin) return safeReply(ctx, '🚫 نمی‌توان ادمین/سازنده را میوت کرد.')
    if (g?.emperor_id && g.emperor_id === target.id) return safeReply(ctx, '⚠️ روی امپراتور نمی‌توان این عملیات را انجام داد.')
    const { dur } = extractArgs(text)
    const ms = dur ? parseDuration(dur) : 10*60*1000
    const until = Math.floor((Date.now() + ms)/1000)
    const ok = await safeRestrict(ctx, target.id, { can_send_messages: false }, until)
    if (ok) {
      await setMute(ctx.chat.id, target.id, until)
      await logAudit(ctx.chat.id, actorId, 'mute', target.id, '-')
      return safeReply(ctx, `🔇 سکوت ${target.first_name} تا ${human(ms)}`)
    }
    return
  }
  if (matchAny(text, KW.unmute)) {
    if (!canUse(actorRole, Cap.UNMUTE)) return
    const ok = await safeRestrict(ctx, target.id, {
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
    if (ok) {
      await delMute(ctx.chat.id, target.id)
      await logAudit(ctx.chat.id, actorId, 'unmute', target.id, '-')
      return safeReply(ctx, `🔊 رفع سکوت: ${target.first_name}`)
    }
    return
  }

  // WARN / UNWARN
  if (matchAny(text, KW.warn)) {
    if (!canUse(actorRole, Cap.WARN)) return safeReply(ctx, 'مجوز اخطار نداری.')
    if (!canActOn(actorRole, targetRole)) return safeReply(ctx, 'اجازه نداری.')
    if (g?.emperor_id && g.emperor_id === target.id) return safeReply(ctx, '⚠️ روی امپراتور نمی‌توان این عملیات را انجام داد.')
    const c = await getWarnCount(ctx.chat.id, target.id)
    const next = c + 1
    await setWarnCount(ctx.chat.id, target.id, next, '-')
    await logAudit(ctx.chat.id, actorId, 'warn', target.id, '-')
    if (next >= 3) {
      if (await isAdmin(ctx, target.id)) return safeReply(ctx, '🚫 ادمین را نمی‌توان تبعید کرد حتی با ۳ اخطار.')
      const ok = await safeBan(ctx, target.id)
      if (ok) { await resetWarn(ctx.chat.id, target.id); return safeReply(ctx, '🚫 ۳ اخطار → تبعید شد.') }
      return
    }
    return safeReply(ctx, `⚠️ اخطار ${next}/3 برای ${target.first_name}`)
  }
  if (matchAny(text, KW.unwarn)) {
    if (!canUse(actorRole, Cap.UNWARN)) return
    await resetWarn(ctx.chat.id, target.id)
    await logAudit(ctx.chat.id, actorId, 'unwarn', target.id, '-')
    return safeReply(ctx, '✅ اخطارها ریست شد.')
  }

  // PURGE
  if (matchAny(text, KW.purge)) {
    if (!canUse(actorRole, Cap.PURGE)) return
    try {
      const fromId = replyTo.message_id
      const toId = ctx.message.message_id
      for (let mid = fromId; mid <= toId; mid++) {
        await ctx.deleteMessage(mid).catch(() => {})
      }
      await logAudit(ctx.chat.id, actorId, 'purge', 0, '-')
    } catch { await safeReply(ctx, 'پاکسازی ناموفق.') }
  }
})

// ---------- INLINE CONFIG ----------
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
app.get('/', (req, res) => { res.send('🤖 Bot is running...') })
app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`))

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`)
  if (!WEBHOOK_URL) { console.error('⚠️ WEBHOOK_URL is missing in .env'); return }
  try { await bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`); console.log('✅ Webhook set') } catch (e) { console.error('❌ setWebhook failed:', e) }
})
