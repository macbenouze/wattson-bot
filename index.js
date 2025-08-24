// index.js
// -----------------------------------------------------------------------------
// Wattson — Intervenant conseils pratiques (temps, récup, psycho, diététique)
// LLM : Gemini (API Google) + RAG PDF (rag_gemini.js, optionnel)
// Commandes : !ping, !profil (set/show), !conseil, !ask, !doc add, !doc ask, !ai test
// NOTE : Les commandes de plans/séances sont désactivées (redirigées vers le Coach).
// -----------------------------------------------------------------------------

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
} = require('discord.js');

// ===== RAG (si présent) ======================================================
let rag = null;
try {
  rag = require('./rag_gemini'); // optionnel
} catch {
  console.warn('ℹ️ RAG désactivé (rag_gemini.js introuvable). Les commandes !doc seront inactives.');
}

// ===================== CONFIG PERSONA & SORTIE (intervenant) =================
const BOT_PROFILE = {
  name: 'Wattson',
  role: "intervenant en préparation et hygiène de vie pour triathlètes amateurs",
  audience: "triathlètes amateurs avec vie pro/famille chargée",
  tone: "chaleureux, motivant, rassurant, concret",
  language: "français",
  style: "structuré, clair, puces et tableaux si utile",
  constraints: [
    "NE JAMAIS fournir de plans/séances détaillés. Rediriger vers le Coach.",
    "Se concentrer sur : gestion du temps, récupération, sommeil, charge, psycho/motivation, nutrition simple, organisation pro/famille, matériel/transition, prévention blessures.",
    "Conseils 80/20 : 3–5 actions immédiates (≤10 min) + alternatives si contrainte forte.",
    "Ton rassurant, bienveillant, sans culpabilisation.",
    "Format : titres courts + puces ; 1 tableau synthétique si pertinent.",
  ],
};

const SUPPORT_CHECKLIST = `
- Temps : micro-créneaux, plan B, batching, sac prêt.
- Récupération : sommeil (rituel), mobilité 5–10', auto-massage, RPE.
- Psycho : routine mentale, auto-parler positif, gestion du stress.
- Nutrition : structure repas/collations, hydratation simple, timing avant/après.
- Vie pro/famille : communication, créneaux négociés, logistique minimaliste.
`.trim();

// LLM par défaut
const MODEL_DEFAULTS = { model: 'gemini-2.5-flash', temperature: 0.35, max_tokens: 900 };
// Presets (si besoin): par salon / par rôle
const CHANNEL_PRESETS = {}, ROLE_PRESETS = {};
const OUTPUT_FLAGS = { useEmojis: true, sectionTitles: true };
// Limitation
const ALLOWED_CHANNEL_IDS = new Set([]); // ajoute des IDs pour restreindre
const COOLDOWN_MS = 6000;

// ============================== HELPERS ======================================
function buildSystemPrompt() {
  const constraints = BOT_PROFILE.constraints.map(c => `- ${c}`).join('\n');
  return [
    `Tu es "${BOT_PROFILE.name}", ${BOT_PROFILE.role}.`,
    `Public: ${BOT_PROFILE.audience}.`,
    `Langue: ${BOT_PROFILE.language}.`,
    `Ton: ${BOT_PROFILE.tone}.`,
    `Style: ${BOT_PROFILE.style}.`,
    `Contraintes:\n${constraints}`,
    `Inclure quand utile : ${SUPPORT_CHECKLIST}`,
    `Si on te demande un plan/séance, réponds : "Le Coach fournit l'entraînement. Je peux t'aider sur récupération, temps, nutrition, psychologie, etc."`,
  ].join(' ');
}
function parseFlags(text) {
  const flags = { court:/\s-court\b/i.test(text), long:/\s-long\b/i.test(text), tableau:/\s-tableau\b/i.test(text), sec:/\s-sec\b/i.test(text) };
  const cleaned = text.replace(/\s-(court|long|tableau|sec)\b/gi, '').trim();
  return { flags, cleaned };
}
async function sendInChunks(channel, content) {
  const MAX = 1900; for (let i=0;i<content.length;i+=MAX) await channel.send(content.slice(i,i+MAX));
}
const responded = new Set();
function markResponded(id, ttlMs=60_000){ responded.add(id); setTimeout(()=>responded.delete(id), ttlMs); }
const lastUse = new Map();
function isOnCooldown(uid){ const now=Date.now(), last=lastUse.get(uid)||0; if(now-last<COOLDOWN_MS) return Math.ceil((COOLDOWN_MS-(now-last))/1000); lastUse.set(uid, now); return 0; }

// ======================== PROFIL (contexte de vie) ===========================
const ATHLETES = new Map();
function parseKVs(str){ const kv={}, re=/(\w+)\s*=\s*([^\s]+)/g; let m; while((m=re.exec(str))!==null) kv[m[1]]=m[2]; return kv; }
function setAthlete(uid, kv){ const cur=ATHLETES.get(uid)||{}; ATHLETES.set(uid,{...cur,...kv}); }
function getAthlete(uid){ return ATHLETES.get(uid)||null; }

// ============================ PROMPTS SUPPORT =================================
function buildSupportSystemPrompt(ctx){
  const base = [
    `Tu es "${BOT_PROFILE.name}", ${BOT_PROFILE.role}.`,
    `Public: ${BOT_PROFILE.audience}.`,
    `Langue: ${BOT_PROFILE.language}.`,
    `Ton: ${BOT_PROFILE.tone}.`,
    `Style: ${BOT_PROFILE.style}.`,
    `Rôle : conseils pratiques (temps, récup, psycho, nutrition, logistique), PAS de contenu d'entraînement.`,
    `Toujours proposer : 3–5 actions immédiates (≤10 min), 1–2 alternatives si contrainte forte, et 1 signal d'alerte (quand lever le pied/consulter).`,
    `Inclure quand utile : ${SUPPORT_CHECKLIST}`,
  ];
  if (ctx) base.push(`Contexte athlète: ${Object.entries(ctx).map(([k,v])=>`${k}=${v}`).join(', ')}`);
  return base.join(' ');
}
function isWorkoutLike(text){ return /(échauffement|echauffement|bloc principal|retour au calme|(\d+)\s*x\s*\d+|[0-9]+x[0-9]+)/i.test(text); }
function sanitizeIfWorkout(ans){
  if(!ans || !isWorkoutLike(ans)) return ans;
  return [
    "Le Coach fournit les **séances** et plans détaillés 💪.",
    "De mon côté, voici des **pistes pratiques** pour t’aider autour de l’entraînement :",
    "- Organisation du temps (micro-créneaux, plan B, sac prêt).",
    "- Récupération (sommeil, mobilité 5–10', auto-massage, RPE).",
    "- Psycho/motivation (rituel de mise en action, ancrages positifs).",
    "- Nutrition/hydratation simple avant/après.",
    "Dis-moi ton contexte (semaine type, fatigue, contraintes) et je t’aide à optimiser tout ça."
  ].join('\n');
}

// ================================ GEMINI (LLM) ===============================
let _gemini=null;
async function getGemini(){
  if(_gemini) return _gemini;
  try {
    const { GoogleGenAI } = await import('@google/genai');
    _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    _gemini._flavor='genai';
  } catch {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    _gemini._flavor='generative-ai';
  }
  return _gemini;
}
async function callLLM(system, user, params={}){
  const ai = await getGemini();
  const model = params.model || MODEL_DEFAULTS.model;
  const temperature = params.temperature ?? MODEL_DEFAULTS.temperature;
  const maxOutputTokens = params.max_tokens ?? MODEL_DEFAULTS.max_tokens;

  if (ai._flavor==='genai'){
    const resp = await ai.models.generateContent({
      model,
      contents:[{ role:'user', parts:[{ text:user }]}],
      systemInstruction:{ parts:[{ text:system }] },
      config:{ temperature, maxOutputTokens },
    });
    return resp.text || resp.outputText || resp.response?.text?.() || "Désolé, je n'ai pas de réponse.";
  } else {
    const m = ai.getGenerativeModel({ model, systemInstruction: system });
    const res = await m.generateContent({
      contents:[{ role:'user', parts:[{ text:user }]}],
      generationConfig:{ temperature, maxOutputTokens },
    });
    return (res.response && typeof res.response.text==='function') ? res.response.text() : "Désolé, je n'ai pas de réponse.";
  }
}

// ================================= DISCORD ===================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c)=>{
  const guilds = [...c.guilds.cache.values()].map(g=>`${g.name} (${g.id})`);
  console.log(`✅ Connecté en tant que ${c.user.tag} | Guilds: ${guilds.length} -> ${guilds.join(', ') || 'aucune'}`);
  if(!process.env.DISCORD_BOT_TOKEN) console.warn('⚠️ DISCORD_BOT_TOKEN manquant');
  if(!process.env.GEMINI_API_KEY) console.warn('ℹ️ GEMINI_API_KEY manquant : !ask/!conseil/!doc ask/!ai test échoueront.');
});

// =============================== MESSAGE LOOP ================================
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (ALLOWED_CHANNEL_IDS.size && !ALLOWED_CHANNEL_IDS.has(message.channelId)) return;

    const content = (message.content || '').trim();
    if (!content) return;
    if (responded.has(message.id)) return;

    const canReply = message.inGuild()
      ? message.channel.permissionsFor(message.client.user)?.has(PermissionsBitField.Flags.SendMessages)
      : true;
    if (!canReply) return;

    // !ping
    if (content.toLowerCase() === '!ping') {
      markResponded(message.id);
      return void message.reply('pong 🏓');
    }

    // --- !ai test ------------------------------------------------------------
    if (content.toLowerCase() === '!ai test') {
      markResponded(message.id);
      await message.channel.sendTyping();
      try {
        // 1) test génération
        const sys = "Tu es un test automatique. Réponds uniquement par 'OK'.";
        const gen = await callLLM(sys, 'ping', { max_tokens: 5, temperature: 0.1 });

        // 2) test embeddings (utile pour RAG)
        let embInfo = 'skip';
        try {
          const ai = await getGemini();
          const r = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: ['test embedding'],
          });
          const len = r?.embeddings?.[0]?.values?.length || r?.embedding?.values?.length || 0;
          embInfo = typeof len === 'number' && len > 0 ? `${len}` : 'unknown';
        } catch (e) {
          embInfo = 'error: ' + (e.message || e);
        }

        return void message.reply(`✅ Gemini OK: "${(gen||'').trim()}" | embeddings: ${embInfo}`);
      } catch (e) {
        console.error('!ai test error', e);
        return void message.reply(`❌ Gemini KO: ${(e.message||e).toString().slice(0,300)}`);
      }
    }

    // !profil
    if (content.toLowerCase().startsWith('!profil')) {
      markResponded(message.id);
      const args = content.slice('!profil'.length).trim();
      if (!args || args.toLowerCase() === 'show') {
        const ctx = getAthlete(message.author.id);
        return void message.reply(
          ctx ? `Profil: ${Object.entries(ctx).map(([k,v])=>`${k}=${v}`).join(' | ')}` :
                "Aucun profil. Exemple: `!profil set emploi=temps-plein famille=2enfants dispo=matin fatigue=moderee`"
        );
      }
      if (args.toLowerCase().startsWith('set')) {
        const kv = parseKVs(args.slice(3));
        if (!Object.keys(kv).length) return void message.reply("Aucune donnée. Ex: `!profil set dispo=soir stress=eleve`");
        setAthlete(message.author.id, kv);
        const ctx = getAthlete(message.author.id);
        return void message.reply(`✅ Profil mis à jour: ${Object.entries(ctx).map(([k,v])=>`${k}=${v}`).join(' | ')}`);
      }
      return;
    }

    // !conseil
    if (content.toLowerCase().startsWith('!conseil')) {
      markResponded(message.id);
      const remain = isOnCooldown(message.author.id);
      if (remain > 0) return void message.reply(`⏳ Patiente ${remain}s.`);

      const sujet = content.slice('!conseil'.length).trim();
      if (!sujet) return void message.reply("Utilisation : `!conseil <sujet>`\nEx : `!conseil je manque de temps et je dors mal`");

      await message.channel.sendTyping();
      const ctx = getAthlete(message.author.id);
      const system = buildSupportSystemPrompt(ctx);
      const user = `
Donne des conseils pratiques et motivants pour : "${sujet}".
Exigences :
- Titres courts + puces.
- 3–5 actions immédiates (≤10 min) + 1–2 alternatives fortes contraintes.
- 1 alerte "quand lever le pied/consulter".
- Pas de plan/séance : renvoyer au Coach pour l'entraînement.
      `.trim();

      try {
        let answer = await callLLM(system, user, { max_tokens: 900, temperature: 0.35 });
        answer = sanitizeIfWorkout(answer);
        return answer.length<=1900 ? message.reply(answer) : (await message.reply("Réponse longue ▶️"), sendInChunks(message.channel, answer));
      } catch (e) {
        console.error('!conseil error', e);
        return void message.reply("Oups, impossible de formuler les conseils. Réessaie.");
      }
    }

    // !doc add (ingestion PDF)
    if (content.toLowerCase().startsWith('!doc add')) {
      markResponded(message.id);
      if (!rag) return void message.reply("RAG non installé sur ce déploiement.");
      await message.channel.sendTyping();
      try {
        const arg = content.slice('!doc add'.length).trim();
        const results = [];
        if (arg && /^https?:\/\//i.test(arg)) results.push(await rag.ingestPdfUrl(arg));
        for (const att of message.attachments.values()) {
          const isPdf = (att.contentType||'').includes('pdf') || (att.name||'').toLowerCase().endsWith('.pdf');
          if (!isPdf) continue;
          const fetch = (await import('node-fetch')).default;
          const buf = Buffer.from(await (await fetch(att.url)).arrayBuffer());
          results.push(await rag.ingestPdfBuffer(att.name || `doc_${Date.now()}.pdf`, buf));
        }
        if (!results.length) return void message.reply("Ajoute un PDF en PJ ou une URL. Ex : `!doc add https://exemple.com/guide.pdf`");
        const summary = results.map(r => `• ${r.file} — ${r.chunks} chunks indexés`).join('\n');
        return void message.reply(`✅ Ingestion terminée :\n${summary}`);
      } catch (e) {
        console.error('!doc add error', e);
        return void message.reply("Oups, ingestion échouée. Vérifie le PDF/URL.");
      }
    }

    // !doc ask (Q&A sur PDF)
    if (content.toLowerCase().startsWith('!doc ask')) {
      markResponded(message.id);
      if (!rag) return void message.reply("RAG non installé sur ce déploiement.");
      const remain = isOnCooldown(message.author.id);
      if (remain > 0) return void message.reply(`⏳ Patiente ${remain}s.`);
      const question = content.slice('!doc ask'.length).trim();
      if (!question) return void message.reply("Utilisation : `!doc ask <ta question>`");

      await message.channel.sendTyping();
      try {
        const { context, sources } = await rag.search(question, 8);
        if (!context?.trim()) return void message.reply("Index vide. Ajoute d'abord des PDF avec `!doc add`.");

        const ctx = getAthlete(message.author.id);
        const system = [ buildSupportSystemPrompt(ctx), "Réponds STRICTEMENT à partir du CONTEXTE fourni. Si insuffisant, dis-le.", "CONTEXTE:\n"+context ].join('\n\n');
        let answer = await callLLM(system, question, { max_tokens: 900, temperature: 0.35 });
        answer = sanitizeIfWorkout(answer);
        const out = answer + `\n\nSources: ${sources.map(s => `«${s}»`).join(', ')}`;
        return out.length<=1900 ? message.reply(out) : (await message.reply("Réponse longue ▶️"), sendInChunks(message.channel, out));
      } catch (e) {
        console.error('!doc ask error', e);
        return void message.reply("Oups, recherche/raisonnement échoués.");
      }
    }

    // !ask (générique, garde-fous)
    if (content.toLowerCase().startsWith('!ask')) {
      markResponded(message.id);
      const remain = isOnCooldown(message.author.id);
      if (remain > 0) return void message.reply(`⏳ Patiente ${remain}s.`);
      await message.channel.sendTyping();

      const { flags, cleaned } = parseFlags(content.slice(4));
      const question = cleaned.trim();
      if (!question) return void message.reply("Utilisation : `!ask [-court|-long|-tableau|-sec] ta question`");

      let params = { ...MODEL_DEFAULTS };
      const chPreset = CHANNEL_PRESETS[message.channelId]; if (chPreset) params = { ...params, ...chPreset };
      if (message.member?.roles?.cache) for (const [, role] of message.member.roles.cache) { const r = ROLE_PRESETS[role.name]; if (r) params = { ...params, ...r }; }
      if (flags.court) params.max_tokens = Math.min(params.max_tokens, 400);
      if (flags.long) params.max_tokens = Math.max(params.max_tokens, 1100);
      if (flags.sec) params.temperature = Math.max(0.2, (params.temperature || 0.35) - 0.1);

      const hints = []; if (OUTPUT_FLAGS.sectionTitles) hints.push("Utilise des titres courts (H2/H3).");
      hints.push(flags.tableau ? "Privilégie 1 tableau synthétique si pertinent." : "Privilégie des puces courtes.");
      const ctx = getAthlete(message.author.id);
      const system = buildSupportSystemPrompt(ctx) + ' ' + hints.join(' ');

      try {
        let answer = await callLLM(system, question, params);
        answer = sanitizeIfWorkout(answer);
        return answer.length<=1900 ? message.reply(answer) : (await message.reply("Réponse longue ▶️"), sendInChunks(message.channel, answer));
      } catch (err) {
        console.error('❌ Erreur Gemini:', err);
        return void message.reply("Oups, une erreur est survenue. Réessaie.");
      }
    }

    // Désactiver !seance / !bloc
    if (/^!seance\b/i.test(content) || /^!bloc\b/i.test(content)) {
      markResponded(message.id);
      return void message.reply(
        "🛠️ Les **séances/plans** sont fournis par le **Coach**.\n" +
        "Je t’aide sur **temps, récupération, psycho, nutrition, organisation**.\n" +
        "Exemples : `!conseil je manque de temps en semaine` · `!conseil stress avant compétitions`"
      );
    }

  } catch (err) {
    console.error('❌ Erreur messageCreate:', err);
  }
});

// ============================== EXPRESS (WEB) ================================
// Garde ce bloc SEULEMENT si ton service Railway est un "Web Service".
// Si tu es en "Background Worker", commente/supprime ce bloc.
const express = require('express');
const app = express();

app.get('/', (_, res) => res.send('ok'));

// --- Route de santé pour Gemini ---------------------------------------------
app.get('/health/ai', async (_, res) => {
  try {
    const out = await callLLM("Tu es un test. Réponds 'OK'.", "ping", { max_tokens: 5, temperature: 0.1 });
    res.json({ ok: true, reply: (out||'').trim() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP up on', PORT));

// ================================ SÉCU =======================================
process.on('unhandledRejection', (r) => console.error('UNHANDLED REJECTION:', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e));

// ================================= START =====================================
client.login(process.env.DISCORD_BOT_TOKEN);

