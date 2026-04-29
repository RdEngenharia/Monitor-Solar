import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import cors from "cors";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit, doc, setDoc, deleteDoc, writeBatch } from 'firebase/firestore';

// Carrega config do Firebase
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
} catch (e) {
  console.error("Erro ao carregar Firebase Config:", e);
}
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Inicialização Gemini para Cron/Backend
let genAI: GoogleGenerativeAI | null = null;
function getGenAI() {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY não configurada no servidor.");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

async function enviarPush(titulo: string, corpo: string) {
  const token = process.env.PUSHBULLET_TOKEN;
  if (!token) return;

  try {
    await axios.post('https://api.pushbullet.com/v2/pushes', {
      type: 'note',
      title: titulo,
      body: corpo
    }, {
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    console.log("[Pushbullet] Notificação enviada.");
  } catch (err) {
    console.error("[Pushbullet] Erro ao enviar notificação:", err);
  }
}

async function analisarLead(titulo: string, snippet: string) {
  try {
    const model = getGenAI().getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `
      Você é um Engenheiro de Dados Sênior especialista em prospecção técnica para a RD Engenharia (Bahia).
      Sua missão é validar se este post é um LEAD QUENTE ou RUÍDO DE MERCADO.

      Texto do Post: "${titulo} - ${snippet}"

      CRITÉRIOS DE FILTRAGEM (RD ENGENHARIA):
      1. REGRAS DE EXCLUSÃO (RETORNE RUÍDO):
         - Marketing ou propaganda de outras empresas.
         - Agradecimentos a parceiros (ex: 'fulano chegou por indicação', 'parceria fechada').
         - Posts de instaladores solares vendendo kits.
         - Conteúdo amador sem intenção de contratação.
      
      2. REGRAS DE APROVAÇÃO (RETORNE URGENTE/NORMAL):
         - Pedidos diretos de indicação ("Alguém conhece um engenheiro?").
         - Dúvidas técnicas sobre HOMOLOGAÇÃO COELBA ou RATEIO.
         - Problemas com AUMENTO DE CARGA ou REFORMA DE PADRÃO.
         - Pedidos de orçamento para projeto elétrico ou solar.

      3. GEOGRAFIA: Identifique a CIDADE mencionada na Bahia. Se não houver, use 'Bahia (Geral)'.

      Responda EXCLUSIVAMENTE em JSON:
      {
        "status": "URGENTE" | "NORMAL" | "RUÍDO",
        "categoria": "Oportunidade" | "Homologação" | "Coelba" | "Infraestrutura",
        "localizacao": "Nome da Cidade",
        "justificativa": "Explicação técnica curta de por que foi aprovado ou descartado"
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const analise = JSON.parse(text);

    // Se for um lead real, envia notificação Push (Gatilho de Alerta)
    if (analise.status !== "RUÍDO") {
      await enviarPush(
        `🚨 NOVO LEAD - RD ENGENHARIA`,
        `📍 Local: ${analise.localizacao}\n📝 Pedido: ${titulo}\n💡 Motivo: ${analise.justificativa}`
      );
    }

    return analise;
  } catch (err) {
    console.error("Erro na análise Gemini:", err);
    return { status: "NORMAL", categoria: "Oportunidade", localizacao: "Bahia (Geral)", justificativa: "Erro na análise" };
  }
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

export default app;

async function startServer() {

  // API para executar o monitoramento diretamente (Dashboard ou Vercel Cron)
  app.all("/api/monitor", async (req, res) => {
    // Vercel Cron envia um cabeçalho de autorização se configurado, mas aqui permitimos gatilho direto
    console.log("Iniciando Monitoramento Automático (Bahia)...");
    
    const SERPER_KEY = process.env.serper;
    if (!SERPER_KEY) {
      return res.status(500).json({ error: "Configuração ausente: serper (API Key)." });
    }

    const termos = [
      'site:facebook.com "alguém indica" "engenheiro" "Coelba"',
      'site:facebook.com "quem faz" "homologação" "solar" "Bahia"',
      'site:facebook.com "preciso aumentar a carga" "padrão"',
      'site:instagram.com "alguém conhece" "engenheiro" "elétrico" "Bahia"',
      'site:facebook.com "alteração de rateio" "energia solar" "ajuda"'
    ];

    try {
      const resultsProcessed = [];
      const seenLinks = new Set();

      for (const termo of termos) {
        const response = await axios.post('https://google.serper.dev/search', {
          q: termo,
          gl: "br",
          hl: "pt-br",
          num: 10,
          tbs: "qdr:m"
        }, {
          headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }
        });

        const organic = response.data.organic || [];
        for (const item of organic) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            
            // Analisa com Gemini no SERVIDOR (Ideal para Cron Jobs)
            const analise = await analisarLead(item.title, item.snippet);
            
            if (analise.status === "RUÍDO" || analise.categoria === "Spam") {
              continue; 
            }

            const dataToSave = {
              termo_origem: termo,
              titulo: item.title,
              link: item.link,
              descricao: item.snippet,
              categoria: analise.categoria,
              status_prioridade: analise.status,
              localizacao: analise.localizacao,
              justificativa: analise.justificativa,
              data_coleta: new Date().toLocaleString('pt-BR'),
              timestamp: new Date().toISOString(),
              impacto: analise.status === "URGENTE" ? "Alto" : "Médio"
            };

            const cleanId = item.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
            await setDoc(doc(db, 'solar_mentions', cleanId), dataToSave, { merge: true });
            resultsProcessed.push(dataToSave);
          }
        }
      }

      res.json({ 
        message: "Monitoramento concluído com sucesso.", 
        new_leads: resultsProcessed.length,
        status: resultsProcessed.length > 0 ? "Leads encontrados" : "Nenhum lead novo"
      });
    } catch (error) {
      console.error("Erro no cron monitor:", error);
      res.status(500).json({ error: "Falha ao executar monitoramento autônomo." });
    }
  });

  // API para testar o fluxo de prospecção e notificação
  app.post("/api/test-lead", async (req, res) => {
    const leadTeste = {
      termo_origem: "SIMULAÇÃO MANUAL",
      titulo: "[TESTE] Alguém indica engenheiro para homologação Coelba em Salvador?",
      link: "https://facebook.com/teste-lead-" + Date.now(),
      descricao: "Preciso de um engenheiro urgente para projeto de aumento de carga em Salvador.",
      categoria: "Oportunidade",
      status_prioridade: "URGENTE",
      localizacao: "Salvador (Simulado)",
      justificativa: "Lead de teste gerado para conferir se o Pushbullet e o Firebase estão funcionando.",
      data_coleta: new Date().toLocaleString('pt-BR'),
      timestamp: new Date().toISOString(),
      impacto: "Alto"
    };

    try {
      const cleanId = "test_" + Date.now();
      await setDoc(doc(db, 'solar_mentions', cleanId), leadTeste);
      
      await enviarPush(
        "🚨 TESTE DE PROSPECÇÃO - RD",
        `📍 Local: ${leadTeste.localizacao}\n📝 Pedido: ${leadTeste.titulo}\n✅ Sistema funcionando!`
      );

      res.json({ message: "Lead de teste enviado com sucesso!", lead: leadTeste });
    } catch (error) {
      console.error("Erro no teste:", error);
      res.status(500).json({ error: "Falha ao enviar lead de teste." });
    }
  });

  // API para ler do Firestore
  app.get("/api/results", async (req, res) => {
    try {
      const q = query(collection(db, 'solar_mentions'), orderBy('data_coleta', 'desc'), limit(50));
      const querySnapshot = await getDocs(q);
      const data = querySnapshot.docs.map(doc => doc.data());
      res.json(data);
    } catch (error) {
      console.error("Erro ao buscar resultados do Firestore:", error);
      res.status(500).json({ error: "Erro ao consultar o banco de dados." });
    }
  });

  // API para limpar histórico
  app.delete("/api/clear", async (req, res) => {
    try {
      console.log("Solicitação de limpeza de histórico recebida...");
      const snapshot = await getDocs(collection(db, 'solar_mentions'));
      const docs = snapshot.docs;
      
      if (docs.length === 0) {
        return res.json({ message: "Histórico já está vazio." });
      }

      console.log(`Limpando ${docs.length} documentos...`);

      // O Firestore permite no máximo 500 operações por batch
      for (let i = 0; i < docs.length; i += 500) {
        const batch = writeBatch(db);
        const chunk = docs.slice(i, i + 500);
        chunk.forEach((d) => {
          batch.delete(d.ref);
        });
        await batch.commit();
        console.log(`Lote ${Math.floor(i/500) + 1} commitado.`);
      }

      res.json({ message: "Histórico limpo com sucesso.", deletedCount: docs.length });
    } catch (error) {
      console.error("Erro ao limpar Firestore:", error);
      res.status(500).json({ 
        error: "Falha ao limpar o banco de dados.",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
  }
}

startServer();
