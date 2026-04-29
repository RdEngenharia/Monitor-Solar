import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import cors from "cors";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit, doc, setDoc } from 'firebase/firestore';

// Carrega config do Firebase
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Inicializa Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "AIzaSyAlAnxLn5GzVNrj0BPqHZVP9ksnZ56iB84");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const SERPER_KEY = "f7442270fb6dc29ed74c20bd2f2bb55a1a63e4df";

async function analisarComIA(titulo: string, descricao: string) {
  const prompt = `
    Como um analista de mercado solar, analise este resultado de busca:
    Título: ${titulo}
    Texto: ${descricao}

    Responda EXCLUSIVAMENTE em formato JSON (sem markdown):
    {
        "categoria": "Reclamação" ou "Oportunidade" ou "Preços" ou "Informativo",
        "justificativa": "breve explicação de 10 palavras",
        "impacto": "Alto", "Médio" ou "Baixo"
    }
  `;
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error("Erro na IA:", error);
    return {
      categoria: "Informativo",
      justificativa: "Erro na análise automatizada",
      impacto: "Baixo"
    };
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API para executar o monitoramento diretamente via Node
  app.post("/api/monitor", async (req, res) => {
    console.log("Iniciando monitoramento via Serper + Gemini (Node.js)...");
    
    const termos = [
      'energia solar Porto Seguro reclamações',
      'melhor empresa energia solar Porto Seguro',
      'preço placa solar Porto Seguro 2026'
    ];

    try {
      const resultadosEnriquecidos = [];

      for (const termo of termos) {
        console.log(`Buscando: ${termo}`);
        const response = await axios.post('https://google.serper.dev/search', {
          q: termo,
          gl: "br",
          hl: "pt-br",
          num: 5
        }, {
          headers: {
            'X-API-KEY': SERPER_KEY,
            'Content-Type': 'application/json'
          }
        });

        const links = response.data.organic || [];

        for (const link of links) {
          console.log(`Analisando link: ${link.title}`);
          const analise = await analisarComIA(link.title, link.snippet);
          
          const item = {
            termo_origem: termo,
            titulo: link.title,
            link: link.link,
            descricao: link.snippet,
            data_coleta: new Date().toISOString().replace('T', ' ').split('.')[0],
            ...analise,
            timestamp: new Date().toISOString()
          };

          // Salva no Firestore
          const cleanId = link.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
          await setDoc(doc(db, 'solar_mentions', cleanId), item);
          
          resultadosEnriquecidos.push(item);
        }
      }

      res.json({ message: "Monitoramento concluído.", count: resultadosEnriquecidos.length });
    } catch (error) {
      console.error("Erro no monitoramento:", error);
      res.status(500).json({ error: "Falha ao executar monitoramento no servidor." });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

startServer();
