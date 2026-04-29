import express from "express";
import cors from "cors";
import axios from "axios";
import path from "path";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generai";
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, setDoc, doc, query, orderBy, limit, getDocs, writeBatch } from 'firebase/firestore';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO FIREBASE RESILIENTE ---
let firebaseConfig: any = {};
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
} catch (e) {}

if (!firebaseConfig.apiKey) {
  firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID,
    firestoreDatabaseId: (process.env.VITE_FIREBASE_DATABASE_ID || process.env.FIREBASE_DATABASE_ID || '(default)')
  };
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// --- FUNÇÕES AUXILIARES ---
async function enviarPush(titulo: string, mensagem: string) {
  const token = process.env.PUSHBULLET_TOKEN;
  if (!token) return;
  try {
    await axios.post('https://api.pushbullet.com/v2/pushes', {
      type: 'note',
      title: titulo,
      body: mensagem
    }, { headers: { 'Access-Token': token, 'Content-Type': 'application/json' } });
  } catch (e) { console.error("Push falhou"); }
}

async function analisarLead(titulo: string, snippet: string) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Você é um Engenheiro de Dados Sênior focado em prospecção para a RD Engenharia (Bahia).
    Analise o post: "${titulo} - ${snippet}"
    REGRAS: Aprove apenas pedidos de indicação de engenheiro, dúvidas sobre homologação Coelba, aumento de carga ou rateio.
    Responda em JSON: {"status": "URGENTE"|"NORMAL"|"RUÍDO", "categoria": "Homologação"|"Infraestrutura"|"Outros", "localizacao": "Cidade", "justificativa": "curta"}`;
    
    const result = await model.generateContent(prompt);
    return JSON.parse(result.response.text());
  } catch (e) {
    return { status: "RUÍDO", categoria: "Erro", localizacao: "N/A", justificativa: "Falha na IA" };
  }
}

// --- ROTAS DA API (Sempre retornando JSON) ---

app.all("/api/monitor", async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const SERPER_KEY = process.env.serper || process.env.SERPER_API_KEY;
    if (!SERPER_KEY) return res.status(500).json({ success: false, error: "Variável 'serper' não configurada." });

    const termos = [
      'site:facebook.com "alguém indica" "engenheiro" "Coelba"',
      'site:facebook.com "quem faz" "homologação" "solar" "Bahia"',
      'site:facebook.com "preciso aumentar a carga" "padrão"',
      'site:instagram.com "alguém conhece" "engenheiro" "elétrico" "Bahia"'
    ];

    const results = [];
    for (const termo of termos) {
      if (results.length >= 5) break; // Limite para evitar timeout 10s da Vercel
      const resp = await axios.post('https://google.serper.dev/search', { q: termo, gl: "br", hl: "pt-br", num: 3, tbs: "qdr:m" }, {
        headers: { 'X-API-KEY': SERPER_KEY }, timeout: 4000
      });
      
      for (const item of (resp.data.organic || [])) {
        const analise = await analisarLead(item.title, item.snippet);
        if (analise.status !== "RUÍDO") {
          const id = item.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
          const data = { ...analise, titulo: item.title, link: item.link, timestamp: new Date().toISOString() };
          await setDoc(doc(db, 'solar_mentions', id), data, { merge: true });
          results.push(data);
          if (results.length === 1) await enviarPush("🚨 Novo Lead RD", `📍 ${analise.localizacao}\n📝 ${item.title}`);
        }
      }
    }
    return res.status(200).json({ success: true, new_leads: results.length });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || "Erro interno no servidor" });
  }
});

app.post("/api/test-lead", async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const id = "test_" + Date.now();
    const mock = { titulo: "Teste Bahia", localizacao: "Salvador", categoria: "Homologação", timestamp: new Date().toISOString() };
    await setDoc(doc(db, 'solar_mentions', id), mock);
    await enviarPush("✅ Teste RD", "Sistema de prospecção Bahia validado.");
    return res.status(200).json({ success: true, message: "Teste concluído com sucesso" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/results", async (req, res) => {
  try {
    const snap = await getDocs(query(collection(db, 'solar_mentions'), orderBy('timestamp', 'desc'), limit(50)));
    res.json(snap.docs.map(d => d.data()));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/clear", async (req, res) => {
  try {
    const snap = await getDocs(collection(db, 'solar_mentions'));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Middleware Final para garantir que nada escape do formato JSON
app.use((err: any, req: any, res: any, next: any) => {
  res.status(500).json({ success: false, error: "Crash inesperado", details: err.message });
});

export default app;
