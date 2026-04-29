import express from "express";
import { createServer as createViteServer } from "vite";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import cors from "cors";
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit, doc, setDoc } from 'firebase/firestore';

// Carrega config do Firebase
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API para executar o monitoramento Python e subir pro Firebase
  app.post("/api/monitor", (req, res) => {
    console.log("Iniciando execução do script Python (Serper API)...");
    
    exec("python3 coletor.py", async (error, stdout, stderr) => {
      if (error) {
        console.error(`Erro: ${error.message}`);
        return res.status(500).json({ error: "Erro ao executar script Python." });
      }
      
      try {
        const filePath = path.join(process.cwd(), "dados_solar_ps.json");
        if (!fs.existsSync(filePath)) {
          return res.status(500).json({ error: "O relatório não foi gerado." });
        }
        const rawData = fs.readFileSync(filePath, "utf-8");
        const results = JSON.parse(rawData);

        // Upload para o Firestore
        const solarCol = collection(db, 'solar_mentions');
        for (const item of results) {
          // Usa uma hash do link como ID para evitar duplicatas em cada monitoramento
          // Aqui vamos apenas dar um set no Firestore. Link servirá como base para ID limpo.
          const cleanId = item.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 128);
          await setDoc(doc(db, 'solar_mentions', cleanId), item);
        }

        res.json({ message: "Monitoramento concluído e sincronizado com Firebase.", count: results.length });
      } catch (err) {
        console.error("Erro ao sincronizar com Firebase:", err);
        res.status(500).json({ error: "Erro ao processar e salvar no banco de dados." });
      }
    });
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
