import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import cors from "cors";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

// 1. Configuração do Firebase (Tenta carregar arquivo ou usar Variáveis de Ambiente)
let firebaseConfig: any;
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    firebaseConfig = {
      apiKey: process.env.VITE_FIREBASE_API_KEY,
      authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.VITE_FIREBASE_APP_ID,
      firestoreDatabaseId: process.env.VITE_FIREBASE_DATABASE_ID || '(default)'
    };
  }
} catch (e) { console.error("Erro Firebase Config:", e); }

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// 2. Função de Notificação Pushbullet
async function enviarPush(titulo: string, corpo: string) {
  const token = process.env.PUSHBULLET_TOKEN;
  if (!token) return;
  try {
    await axios.post('https://api.pushbullet.com/v2/pushes', {
      type: 'note',
      title: titulo,
      body: corpo
    }, { headers: { 'Access-Token': token, 'Content-Type': 'application/json' } });
  } catch (err) { console.error("Erro Pushbullet:", err); }
}

// 3. Inteligência Artificial (Gemini) - Filtragem de Leads
async function analisarLead(titulo: string, snippet: string) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Analise se este post é um LEAD REAL para engenharia elétrica (Bahia).
    Post: "${titulo} - ${snippet}"
    REGRAS: Ignore propaganda e agradecimentos. Aprove pedidos de indicação, homologação Coelba, rateio ou aumento de carga.
    Responda em JSON: {"status": "URGENTE" | "NORMAL" | "RUÍDO", "categoria": "Oportunidade" | "Homologação" | "Coelba", "localizacao": "Cidade", "justificativa": "curta"}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const analise = JSON.parse(text);

    if (analise.status !== "RUÍDO") {
      await enviarPush(`🚨 NOVO LEAD - RD ENGENHARIA`, `📍 ${analise.localizacao}\n📝 ${titulo}\n💡 ${analise.justificativa}`);
    }
    return analise;
  } catch (err) { return { status: "RUÍDO" }; }
}

const app = express();
app.use(cors());
app.use(express.json());

// 4. Rota principal de busca (O que o botão "Buscar Agora" chama)
app.all("/api/monitor", async (req, res) => {
  const SERPER_KEY = process.env.serper;
  const termos = [
    'site:facebook.com "alguém indica" "engenheiro" "Coelba"',
    'site:facebook.com "quem faz" "homologação" "solar" "Bahia"',
    'site:facebook.com "preciso aumentar a carga" "padrão"'
  ];

  try {
    let encontrados = 0;
    for (const q of termos) {
      const resp = await axios.post('https://google.serper.dev/search', { q, gl: "br", tbs: "qdr:m" }, { headers: { 'X-API-KEY': SERPER_KEY! } });
      const items = resp.data.organic || [];
      for (const item of items) {
        const analise = await analisarLead(item.title, item.snippet);
        if (analise.status !== "RUÍDO") {
          const id = item.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
          await setDoc(doc(db, 'solar_mentions', id), { ...item, ...analise, data_coleta: new Date().toLocaleString() }, { merge: true });
          encontrados++;
        }
      }
    }
    res.json({ message: "Sucesso", leads: encontrados });
  } catch (e) { res.status(500).send("Erro"); }
});

export default app;
