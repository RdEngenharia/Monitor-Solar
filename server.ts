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
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Inicialização tardia para evitar erros no boot (conforme diretrizes)
let model: any = null;

function getGeminiModel() {
  if (!model) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("Variável de ambiente GEMINI_API_KEY não configurada.");
    }
    const genAI = new GoogleGenerativeAI(key);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  }
  return model;
}

async function analisarComIA(titulo: string, descricao: string) {
  const prompt = `
    Aja como um Engenheiro Eletrotécnico Sênior e Especialista em SEO Técnico de Porto Seguro, Bahia. 
    Analise este resultado de busca focado em prospecção de alta precisão:

    Título: ${titulo}
    Conteúdo: ${descricao}

    Sua missão é detectar LEADS QUENTES (Oportunidades reais) para:
    1. Homologação de Microgeração Solar (Prazos Coelba, Projetos, Vistorias)
    2. Engenharia de Redes (Aumento de Carga, Alteração de Padrão Monofásico p/ Trifásico)
    3. Gestão Energética (Alteração de Rateio entre apartamentos/casas, Gestão de Créditos)

    Classifique como "Oportunidade" apenas se houver intenção de contratação, pedido de indicação ou dúvida técnica urgente.
    Classifique como "Coelba" ou "Homologação" se for post informativo técnico.
    Classifique como "Spam" se for propaganda genérica, venda de motos/veículos, ou notícias irrelevantes.

    Responda EXCLUSIVAMENTE em JSON:
    {
        "categoria": "Oportunidade" | "Homologação" | "Coelba" | "Spam",
        "justificativa": "Explicação técnica curta de por que isso é um lead ou spam",
        "impacto": "Alto" (se pedir profissional/indicação/preço), "Médio" ou "Baixo"
    }
  `;
  try {
    const aiModel = getGeminiModel();
    const result = await aiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(text);
    return parsed;
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
    
    const SERPER_KEY = process.env.SERPER_API_KEY;
    if (!SERPER_KEY) {
      return res.status(500).json({ error: "Configuração ausente: SERPER_API_KEY." });
    }
    const termos = [
      // Perguntas e Indicações Diretas (Exatas do Usuário)
      'site:facebook.com "Porto Seguro" "alguém indica" "engenheiro" "padrão" -notícia -curso -vaga -emprego -"reclame aqui"',
      'site:facebook.com "Trancoso" "quem faz" "homologação" "Coelba" -notícia -curso -vaga -emprego -"reclame aqui"',
      'site:instagram.com "Arraial d\'Ajuda" "indicação" "alteração de carga" -notícia -curso -vaga -emprego -"reclame aqui"',
      'site:facebook.com "Porto Seguro" "rateio" "energia solar" "grupo" -notícia -curso -vaga -emprego -"reclame aqui"',

      // Variações Criativas de Alta Intenção
      'site:facebook.com "Porto Seguro" "quem faz" "projeto elétrico" residencial -notícia -curso -vaga -emprego',
      'site:facebook.com "Porto Seguro" "indicação" "aumento de carga" trifásico -notícia -curso -vaga -emprego',
      'site:facebook.com "Trancoso" "alguém indica" engenheiro Coelba -notícia -curso -vaga -emprego',
      'site:facebook.com "Arraial d\'Ajuda" "preciso de um" engenheiro eletricista -notícia -curso -vaga -emprego',
      'site:facebook.com "Porto Seguro" "padrão monofásico para trifásico" custo -notícia -curso -vaga -emprego',
      'site:facebook.com "Porto Seguro" "dividir energia solar" entre casas -notícia -curso -vaga -emprego',
      'site:facebook.com "Bahia" "homologação de microgeração" Coelba passo a passo -notícia -curso -vaga -emprego',
      
      // Google Search (Perguntas em Blogs e Fóruns)
      '"alguém indica" engenheiro para aumento de carga em Porto Seguro',
      '"como fazer" rateio de energia solar entre casas Coelba',
      'Projeto de "homologação de energia solar" preço Bahia',
      'Alteração de "padrão de energia" para trifásico Coelba Porto Seguro',
      'Engenheiro para "legalizar" energia solar Coelba Porto Seguro',
      '"quem projeta" entrada de serviço padrão Coelba Porto Seguro',
      
      // Instagram (Busca de termos em publicações)
      'site:instagram.com "Porto Seguro" "engenheiro elétrico" indicação -vaga',
      'site:instagram.com "Trancoso" "homologação solar" Coelba -vaga',
      'site:instagram.com "Arraial d\'Ajuda" "projeto elétrico" orçamento -vaga'
    ];

    try {
      const resultadosEnriquecidos = [];
      const seenLinks = new Set(); // Evita duplicados na mesma rodada

      for (const termo of termos) {
        console.log(`Buscando: ${termo}`);
        const response = await axios.post('https://google.serper.dev/search', {
          q: termo,
          gl: "br",
          hl: "pt-br",
          num: 15,
          tbs: "qdr:m"
        }, {
          headers: {
            'X-API-KEY': SERPER_KEY,
            'Content-Type': 'application/json'
          }
        });

        const links = response.data.organic || [];

        for (const link of links) {
          if (seenLinks.has(link.link)) continue;
          seenLinks.add(link.link);

          console.log(`Analisando link: ${link.title}`);
          const analise = await analisarComIA(link.title, link.snippet);
          
          // Se for Spam, ignoramos o resultado
          if (analise.categoria === 'Spam') {
            console.log("Resultado ignorado: Spam identificado.");
            continue;
          }

          const item = {
            termo_origem: termo,
            titulo: link.title,
            link: link.link,
            descricao: link.snippet,
            data_coleta: new Date().toLocaleString('pt-BR'),
            ...analise,
            timestamp: new Date().toISOString()
          };

          // Deduplicação no Firestore: Usamos o link como ID fixo. 
          // Se o link já existir, ele só será atualizado se os dados mudarem.
          const cleanId = link.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
          await setDoc(doc(db, 'solar_mentions', cleanId), item, { merge: true });
          
          resultadosEnriquecidos.push(item);
        }
      }

      res.json({ message: "Monitoramento concluído com foco técnico.", count: resultadosEnriquecidos.length });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

startServer();
