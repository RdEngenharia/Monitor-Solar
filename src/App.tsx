import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sun, 
  Search, 
  AlertCircle, 
  CheckCircle2, 
  ExternalLink, 
  RefreshCcw, 
  Database,
  MapPin,
  TrendingDown,
  ShieldAlert,
  Info,
  LogIn,
  User,
  Trash2
} from 'lucide-react';
import { db, auth, signInWithGoogle } from './lib/firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { GoogleGenAI } from "@google/genai";

interface SearchResult {
  termo_origem: string;
  titulo: string;
  link: string;
  descricao: string;
  data_coleta: string;
  categoria?: string;
  status_prioridade?: string;
  justificativa?: string;
  impacto?: string;
  timestamp?: string;
  localizacao?: string;
}

export default function App() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'checking' | 'error'>('idle');
  const [user, setUser] = useState<FirebaseUser | null>(null);

  // Inicializa Gemini Client Side conforme SKILL.md
  const genAI = useMemo(() => {
    const key = (process.env as any).GEMINI_API_KEY;
    if (!key) return null;
    return new GoogleGenAI({ apiKey: key });
  }, []);

  useEffect(() => {
    // Listener de Autenticação
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });

    // Listener Real-time do Firestore
    const q = query(collection(db, 'solar_mentions'), orderBy('data_coleta', 'desc'), limit(50));
    const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => doc.data() as SearchResult);
      setResults(data);
    }, (error) => {
      console.error("Erro no listener do Firestore:", error);
    });

    return () => {
      unsubscribeAuth();
      unsubscribeSnapshot();
    };
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithGoogle();
    } catch (error: any) {
      console.error("Erro completo do Firebase Login:", error);
      if (error.code === 'auth/popup-blocked') {
        alert("O popup de login foi bloqueado pelo seu navegador. Por favor, autorize popups para este site.");
      } else if (error.code === 'auth/unauthorized-domain') {
        alert("Domínio não autorizado! Adicione o domínio atual (" + window.location.hostname + ") no Console do Firebase > Authentication > Settings > Authorized Domains.");
      } else if (error.code === 'auth/operation-not-allowed') {
        alert("Método de login (Google) desativado! Ative o provedor Google no Console do Firebase > Authentication > Sign-in method.");
      } else {
        alert("Erro ao fazer login: " + (error.message || "Erro desconhecido"));
      }
    }
  };

  const runMonitor = async () => {
    setLoading(true);
    setStatus('running');
    try {
      // O Servidor agora faz a busca E a análise IA (Melhor para Cron Jobs)
      const response = await fetch('/api/monitor', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details || "Erro desconhecido no servidor");
      }
      
      console.log("Monitoramento finalizado pelo servidor:", data);
      setStatus('success');
    } catch (error: any) {
      console.error("Erro ao rodar monitoramento:", error);
      alert(`Falha no Monitoramento: ${error.message}`);
      setStatus('error');
    } finally {
      setLoading(false);
    }
  };

  const clearHistory = async () => {
    if (!confirm("Tem certeza que deseja limpar todo o histórico de pesquisas?")) return;
    try {
      setLoading(true);
      const response = await fetch('/api/clear', { method: 'DELETE' });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.details || data.error || "Erro desconhecido");
      
      setResults([]);
      alert("Sucesso: " + data.message + (data.deletedCount ? ` (${data.deletedCount} itens removidos)` : ""));
    } catch (error: any) {
      console.error("Erro ao limpar histórico:", error);
      alert("Falha ao limpar histórico: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (label: string) => {
    const low = label.toLowerCase();
    if (low.includes('reclamação') || low.includes('problema')) return <ShieldAlert className="text-amber-500" size={18} />;
    if (low.includes('preço') || low.includes('oportunidade')) return <TrendingDown className="text-emerald-500" size={18} />;
    return <Info className="text-blue-500" size={18} />;
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 selection:bg-orange-100 selection:text-orange-900">
      {loading && status === 'checking' && (
        <div className="fixed top-0 left-0 w-full h-1 bg-orange-200 z-[100]">
          <motion.div 
            className="h-full bg-orange-600"
            animate={{ width: ['0%', '100%'] }}
            transition={{ duration: 15, repeat: Infinity }}
          />
        </div>
      )}
      {/* Top Banner */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 p-2 rounded-lg text-white shadow-sm ring-1 ring-orange-600/20">
              <Sun size={20} className="animate-pulse" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">SolarWatch <span className="text-slate-400 font-normal">Extremo Sul • Homologação & Coelba</span></h1>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <div className="hidden sm:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full border border-slate-200">
                <img src={user.photoURL || ''} alt={user.displayName || ''} className="w-5 h-5 rounded-full" />
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-tight">{user.displayName?.split(' ')[0]}</span>
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-900 transition-colors"
              >
                <LogIn size={14} /> Login
              </button>
            )}
            {user && (
              <button
                onClick={clearHistory}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-2 rounded-full text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-red-600 transition-all active:scale-95 disabled:opacity-50"
                title="Limpar Histórico"
              >
                <Trash2 size={16} />
                <span className="hidden sm:inline">Limpar</span>
              </button>
            )}
            <button
              onClick={async () => {
                if (confirm("Deseja enviar um lead de teste para seu celular e Firebase?")) {
                  const res = await fetch('/api/test-lead', { method: 'POST' });
                  if (res.ok) alert("Teste enviado! Verifique seu Pushbullet e a lista de resultados.");
                }
              }}
              className="hidden md:block text-[10px] font-bold text-slate-400 hover:text-slate-900 transition-colors uppercase tracking-widest border border-slate-200 px-3 py-2 rounded-full"
            >
              Simular Lead
            </button>
            <button
              onClick={runMonitor}
              disabled={loading}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-300 ${
                loading 
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                  : 'bg-slate-900 text-white hover:bg-slate-800 shadow-sm active:scale-95'
              }`}
            >
              {loading ? <RefreshCcw size={16} className="animate-spin" /> : <Search size={16} />}
              {loading 
                ? (status === 'checking' ? 'Analisando Leads...' : 'Buscando...') 
                : 'Iniciar Busca'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          
          {/* Sidebar Info */}
          <aside className="lg:col-span-1 space-y-6">
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Configuração</h2>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Database size={16} className="text-slate-400 mt-1" />
                  <div>
                    <p className="text-sm font-medium">googlesearch-python</p>
                    <p className="text-xs text-slate-500">Motor de busca v2.4</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <AlertCircle size={16} className="text-slate-400 mt-1" />
                  <div>
                    <p className="text-sm font-medium">Delay Anti-Bot</p>
                    <p className="text-xs text-slate-500">5s - 12s Randômico</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 p-5 rounded-2xl text-white shadow-xl shadow-slate-200">
              <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
                <ShieldAlert size={16} className="text-orange-400" /> Alerta de Mercado
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Este monitor foca em reputação (reclamações) e pricing de 2026 para antecipar movimentos da concorrência em Porto Seguro.
              </p>
            </div>
          </aside>

          {/* Results Area */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold flex items-center gap-2">
                Relatório de Monitoramento 
                <span className="text-sm font-normal text-slate-400 bg-slate-100 px-2 rounded-md">{results.length} resultados</span>
              </h2>
              {status === 'success' && (
                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                  <CheckCircle2 size={14} /> Dados Atualizados
                </motion.div>
              )}
            </div>

            {results.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center py-24 bg-white rounded-3xl border border-slate-200 border-dashed">
                <div className="bg-slate-50 p-4 rounded-full mb-4">
                  <Search size={32} className="text-slate-300" />
                </div>
                <p className="text-slate-500 font-medium">Nenhum dado capturado ainda.</p>
                <button onClick={runMonitor} className="mt-4 text-orange-600 text-sm font-bold hover:underline">Começar busca agora</button>
              </div>
            ) : (
              <div className="space-y-4">
                <AnimatePresence mode="popLayout">
                  {results.map((res, idx) => (
                    <motion.div
                      key={idx}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="group bg-white p-5 rounded-2xl border border-slate-200 hover:border-orange-200 hover:shadow-md transition-all duration-300"
                    >
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="p-1.5 bg-slate-50 rounded-lg group-hover:bg-orange-50 transition-colors">
                            {getStatusIcon(res.categoria || res.termo_origem)}
                          </span>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {res.termo_origem}
                            </span>
                            {res.categoria && (
                              <div className="flex flex-wrap gap-1">
                                <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded-sm w-fit ${
                                  res.impacto === 'Alto' ? 'bg-red-100 text-red-600' : 
                                  res.impacto === 'Médio' ? 'bg-orange-100 text-orange-600' : 
                                  'bg-blue-100 text-blue-600'
                                }`}>
                                  IA: {res.categoria} • IMPACTO {res.impacto}
                                </span>
                                {res.status_prioridade === 'URGENTE' && (
                                  <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded-sm w-fit bg-red-600 text-white animate-pulse">
                                    URGENTE
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <a 
                          href={res.link} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="text-slate-400 hover:text-orange-500 transition-colors"
                        >
                          <ExternalLink size={16} />
                        </a>
                      </div>
                      <h4 className="font-bold text-slate-800 leading-tight mb-2 group-hover:text-orange-600 transition-colors">
                        {res.titulo}
                      </h4>
                      <p className="text-sm text-slate-500 line-clamp-2 leading-relaxed mb-1">
                        {res.descricao}
                      </p>
                      {res.justificativa && (
                        <p className="text-[11px] italic text-slate-400 mb-4 px-3 py-2 bg-slate-50 border-l-2 border-slate-200 rounded-r-lg">
                          " {res.justificativa} "
                        </p>
                      )}
                      <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                        <span className="text-[10px] text-slate-300 font-medium">COLETADO EM: {res.data_coleta}</span>
                        <span className="text-[10px] text-orange-500 font-bold tracking-widest uppercase flex items-center gap-1">
                          <MapPin size={10} /> {res.localizacao || "Bahia (Geral)"}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>
      </main>
      
      {/* Footer / Status Bar */}
      <footer className="fixed bottom-0 left-0 right-0 h-8 bg-white border-t border-slate-200 px-4 flex items-center justify-between z-40 text-[10px] text-slate-400 font-medium uppercase tracking-[0.1em]">
        <div className="flex gap-4">
          <span>SISTEMA: ATIVO</span>
          <span>MOTOR: NODE.JS + SERPER + GEMINI 1.5</span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${loading ? 'bg-orange-500 animate-pulse' : 'bg-emerald-500'}`}></div>
          SYNC COMPLETO
        </div>
      </footer>
    </div>
  );
}
