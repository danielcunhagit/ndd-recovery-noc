import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Lock, User, Briefcase, ChevronRight, FileSpreadsheet, RefreshCw, UploadCloud, CheckCircle2, Send, Inbox, Settings, X, Minus, Terminal, ArrowLeft, AlertTriangle, AlertCircle, Database, Plus, Filter, Phone, Trash2, Server, Printer, Bot, SlidersHorizontal, Pencil, Eye, EyeOff, Search } from "lucide-react";
import "./App.css";

interface FilteringStats {
  initial_printers: number; initial_companies: number;
  drop_disabled_printers: number; drop_disabled_companies: number;
  drop_brand_printers: number; drop_brand_companies: number;
  flag_2001: number; flag_sporadic: number; matched_sqlite: number;
  final_printers: number; final_companies: number;
}
interface NddResult { report: string; data: any[]; stats: FilteringStats; }

interface Contact {
  id?: number; enterprise_name: string; tel: string; email1: string; email2: string; email3: string;
  nome1: string; nome2: string; nome3: string; consultor: string; codigo_empresa: string;
}

type Screen = "splash" | "login" | "dashboard" | "main_panel" | "contacts" | "syncing" | "email_setup" | "settings" | "settings_signature" | "settings_auth";

const tweenNumber = (start: number, end: number, duration: number, setter: (val: number) => void) => {
  return new Promise<void>(resolve => {
    const startTime = performance.now();
    const update = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setter(Math.floor(start + (end - start) * ease));
      if (progress < 1) requestAnimationFrame(update);
      else resolve();
    };
    requestAnimationFrame(update);
  });
};

const Typewriter = ({ text }: { text: string }) => {
  const [displayedText, setDisplayedText] = useState("");
  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setDisplayedText(text.slice(0, i + 1));
      i++;
      if (i >= text.length) clearInterval(interval);
    }, 15);
    return () => clearInterval(interval);
  }, [text]);
  return <span>{displayedText}</span>;
};

const formatPhone = (val: string) => {
  let cleaned = val.replace(/\D/g, ""); 
  if (cleaned.length > 11) cleaned = cleaned.slice(0, 11); 
  if (cleaned.length === 0) return "";
  if (cleaned.length <= 2) return `(${cleaned}`;
  if (cleaned.length <= 6) return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2)}`;
  if (cleaned.length <= 10) return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 6)}-${cleaned.slice(6)}`;
  return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`; 
};

export default function App() {
  const [isDevMode, setIsDevMode] = useState(true); 
  const [gmailPassword, setGmailPassword] = useState(() => localStorage.getItem("gmailPassword") || "idqn ujgi ndar dejm"); 
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem("geminiKey") || "AIzaSyBDwmSb5WYFucRLeKs3Jdn1kSm6Alw8xE0"); 
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailDispatchLogs, setEmailDispatchLogs] = useState<{msg: string, type: 'info' | 'success' | 'error'}[]>([]);
  
  const [isEditingGmailPass, setIsEditingGmailPass] = useState(false);
  const [isGmailPassVisible, setIsGmailPassVisible] = useState(false);
  const [isEditingGeminiKey, setIsEditingGeminiKey] = useState(false);
  const [isGeminiKeyVisible, setIsGeminiKeyVisible] = useState(false);
  
  const [profileName, setProfileName] = useState("");
  const [profileTitle, setProfileTitle] = useState("");
  const [profileDept, setProfileDept] = useState("");
  const [profilePhone, setProfilePhone] = useState("");
  
  const [offlineDaysThreshold, setOfflineDaysThreshold] = useState(7);
  const [sendToHostOffline, setSendToHostOffline] = useState(true);
  const [sendToPrinterOffline, setSendToPrinterOffline] = useState(true);
  const [missingCompsArray, setMissingCompsArray] = useState<string[]>([]);
  const [syncStats, setSyncStats] = useState({ total: 0, totalCompanies: 0, online: 0, offline: 0, offlineCompanies: 0, missingEmails: 0 });
  const [currentScreen, setCurrentScreen] = useState<Screen>("splash");
  const [splashStep, setSplashStep] = useState(0);
  const [results, setResults] = useState<any[]>([]);
  
  // --- MÁGICA DO RECÁLCULO EM TEMPO REAL ---
  const dispatchPreview = useMemo(() => {
    if (!results || results.length === 0) return { emails: 0, printers: 0 };

    const companiesMap = new Map<string, any[]>();
    results.forEach(p => {
      if (p["Passivel de Monitoramento"] === "NÃO") return; // Ignora 2001 e Esporádicos
      const entName = p["EnterpriseName"] || "Desconhecida";
      if (!companiesMap.has(entName)) companiesMap.set(entName, []);
      companiesMap.get(entName)!.push(p);
    });

    let emailsCount = 0;
    let printersCount = 0;

    companiesMap.forEach((impressoras) => {
      const emailCliente = impressoras[0]["email1"] || "";
      if (emailCliente.trim() === "" && !isDevMode) return;

      const totalPrinters = impressoras.length;
      let offlineCount = 0;
      
      // Mapeia quantos dias offline cada máquina tem
      const daysCount = new Map<number, number>();
      let maxSimultaneousDrops = 0; // Qual o maior número de impressoras que caiu no MESMO dia?
      
      impressoras.forEach(p => {
        const days = Number(p["Days without meters"]) || 0;
        if (days >= offlineDaysThreshold) {
          offlineCount++;
          // Agrupa as quedas simultâneas
          const currentCount = (daysCount.get(days) || 0) + 1;
          daysCount.set(days, currentCount);
          if (currentCount > maxSimultaneousDrops) maxSimultaneousDrops = currentCount;
        }
      });

      if (offlineCount === 0) return; // Ninguém offline

      // --- A NOVA REGRA DE OURO (CORRELAÇÃO DE FALHAS) ---
      // É Host Offline SE: Tem 2+ impressoras, e pelo menos METADE delas caiu no exato mesmo dia (e são pelo menos 2 caindo juntas).
      const isHostOffline = totalPrinters >= 2 && maxSimultaneousDrops >= 2 && maxSimultaneousDrops >= (totalPrinters / 2);

      if (isHostOffline && !sendToHostOffline) return;
      if (!isHostOffline && !sendToPrinterOffline) return;

      emailsCount++;
      printersCount += offlineCount; // Soma as impressoras que entraram neste e-mail
    });

    return { emails: emailsCount, printers: printersCount };
  }, [results, offlineDaysThreshold, sendToHostOffline, sendToPrinterOffline, isDevMode]);
  
  const [loginError, setLoginError] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  
  const [printerCount, setPrinterCount] = useState(0);
  const [companyCount, setCompanyCount] = useState(0);
  const [simulatedPrinterCount, setSimulatedPrinterCount] = useState(0);
  const [simulatedCompanyCount, setSimulatedCompanyCount] = useState(0);
  const [syncPhase, setSyncPhase] = useState<"downloading" | "transition" | "cleaning">("downloading");
  const [fakeLogs, setFakeLogs] = useState<{text: string, drop: number, isSuccess?: boolean}[]>([]);
  const [lastStats, setLastStats] = useState<FilteringStats | null>(null);
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [fakeLogs, emailDispatchLogs]);

  const [provider, setProvider] = useState("CANON");
  const [email, setEmail] = useState("dcunha@cusa.canon.com");
  const [password, setPassword] = useState("Desadani123");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [filterMissingEmail, setFilterMissingEmail] = useState(false);
  const [contactSearchTerm, setContactSearchTerm] = useState("");
  const loadContacts = async () => {
    try { setContacts(await invoke<Contact[]>("get_all_contacts")); } 
    catch (err) { alert("Erro ao carregar contatos: " + err); }
  };

  const recalculateStatsOnReturn = async () => {
    try {
      const freshContactsList = await invoke<Contact[]>("get_all_contacts");
      setContacts(freshContactsList); 
      if (results.length === 0) return;

      const validCompanyEmailsMap = new Map<string, string>();
      freshContactsList.forEach(c => { validCompanyEmailsMap.set(c.enterprise_name.toUpperCase().trim(), c.email1 || ""); });

      let offline = 0;
      const offlineComps = new Set<string>();
      const missingEmailComps = new Set<string>();

      results.forEach(p => {
        const days = Number(p["Days without meters"]) || 0;
        if (days > 7) { offline++; if (p["EnterpriseName"]) offlineComps.add(p["EnterpriseName"]); }
        
        if (!p["EnterpriseName"]) return;
        const entNameUpper = p["EnterpriseName"].toUpperCase().trim();
        const emailFoundInDB = validCompanyEmailsMap.get(entNameUpper) || "";
        if (emailFoundInDB.trim() === "") missingEmailComps.add(p["EnterpriseName"]);
      });

      setMissingCompsArray(Array.from(missingEmailComps));
      setSyncStats(prevStats => ({ ...prevStats, online: results.length - offline, offline: offline, offlineCompanies: offlineComps.size, missingEmails: missingEmailComps.size }));
    } catch (err) { console.error("Erro no recálculo:", err); }
  };

  useEffect(() => {
    if (currentScreen === "splash") {
      const t1 = setTimeout(() => setSplashStep(1), 1000);
      const t2 = setTimeout(() => setSplashStep(2), 2000);
      const t3 = setTimeout(() => setCurrentScreen("login"), 3500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, [currentScreen]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setLoginError(""); setIsAuthenticating(true);
    try {
      await invoke("handle_login", { provider, email, password });
      const hasContacts = await invoke<boolean>("check_has_contacts");
      if (hasContacts) { setCurrentScreen("syncing"); startSyncProcess(); } 
      else setCurrentScreen("dashboard");
    } catch (error) {
      setLoginError(String(error)); setIsShaking(true); setTimeout(() => setIsShaking(false), 400); 
    } finally { setIsAuthenticating(false); }
  };

  const handleSelectFile = async () => {
    try {
      const filePath = await open({ multiple: false, directory: false, filters: [{ name: 'Planilhas', extensions: ['xlsx', 'xls'] }] });
      if (filePath && typeof filePath === 'string') setSelectedFile(filePath);
    } catch (error) { console.error("Erro ao selecionar arquivo:", error); }
  };

  const handleProcessExcel = async () => {
    if (!selectedFile) return;
    try {
      await invoke("process_excel_file", { filePath: selectedFile });
      setCurrentScreen("syncing"); startSyncProcess();
    } catch (error) { alert(`Erro: ${error}`); }
  };

  const executeCleaningAnimation = async (stats: FilteringStats) => {
    setSyncPhase("transition");
    setSimulatedPrinterCount(stats.initial_printers);
    setSimulatedCompanyCount(stats.initial_companies);
    await new Promise(r => setTimeout(r, 1000)); 
    
    setSyncPhase("cleaning"); 
    await new Promise(r => setTimeout(r, 600));

    const steps = [
      { text: `Iniciando auditoria da base de dados local...`, dropP: 0, dropC: 0 },
      { text: `Removendo equipamentos com contadores desabilitados`, dropP: stats.drop_disabled_printers, dropC: stats.drop_disabled_companies },
      { text: `Isolando marcas de fabricantes não homologados`, dropP: stats.drop_brand_printers, dropC: stats.drop_brand_companies }
    ];

    let currentP = stats.initial_printers;
    let currentC = stats.initial_companies;

    for (let i = 0; i < steps.length; i++) {
      setFakeLogs(prev => [...prev, { text: steps[i].text, drop: steps[i].dropP }]);
      const nextP = currentP - steps[i].dropP;
      const nextC = currentC - steps[i].dropC;
      const tempoDeDigitacaoMs = steps[i].text.length * 15;

      await new Promise(r => setTimeout(r, tempoDeDigitacaoMs));

      if (steps[i].dropP > 0) {
          tweenNumber(currentP, nextP, 600, setSimulatedPrinterCount);
          tweenNumber(currentC, nextC, 600, setSimulatedCompanyCount);
      }
      await new Promise(r => setTimeout(r, 1200)); 
      currentP = nextP; currentC = nextC;
    }

    setFakeLogs(prev => [...prev, { text: `OPERAÇÃO CONCLUÍDA: ${stats.final_printers.toLocaleString('pt-BR')} impressoras prontas.`, drop: 0, isSuccess: true }]);
    await new Promise(r => setTimeout(r, 1500));
    setCurrentScreen("main_panel");
  };

  const startSyncProcess = async () => {
    setSyncPhase("downloading"); setProgressMsg("Iniciando conexão segura..."); setProgressPercent(0); setPrinterCount(0); setFakeLogs([] as any); 

    const unlisten = await listen<{ message: string; progress: number; printers: number; companies: number }>("ndd-progress", (event) => {
      setProgressMsg(event.payload.message);
      setProgressPercent(event.payload.progress);
      setPrinterCount(event.payload.printers);
      setCompanyCount(event.payload.companies);
    });

    try {
      const result = await invoke<NddResult>("fetch_ndd_data", { provider, email, password });
      if (typeof unlisten === 'function') unlisten();
      
      const data = result.data;
      let offline = 0;
      const offlineComps = new Set<string>();
      const missingEmailComps = new Set<string>();
      
      const freshContactsList = await invoke<Contact[]>("get_all_contacts");
      const validCompanyEmailsMap = new Map<string, string>();
      freshContactsList.forEach(c => { validCompanyEmailsMap.set(c.enterprise_name.toUpperCase().trim(), c.email1 || ""); });
      
      data.forEach(p => {
        const days = Number(p["Days without meters"]) || 0;
        if (days > 7) { offline++; if (p["EnterpriseName"]) offlineComps.add(p["EnterpriseName"]); }
        
        if (p["EnterpriseName"]) {
          const entNameUpper = p["EnterpriseName"].toUpperCase().trim();
          const emailFromDB = validCompanyEmailsMap.get(entNameUpper);
          const emailFromAPI = p["email1"] || "";
          if ((!emailFromDB || emailFromDB.trim() === "") && emailFromAPI.trim() === "") { 
            missingEmailComps.add(p["EnterpriseName"]); 
          }
        }
      });
      setMissingCompsArray(Array.from(missingEmailComps));
      setSyncStats({ total: data.length, totalCompanies: result.stats.final_companies, online: data.length - offline, offline: offline, offlineCompanies: offlineComps.size, missingEmails: missingEmailComps.size });
      setResults(result.data);
      setLastStats(result.stats); 

      await executeCleaningAnimation(result.stats);

    } catch (err) {
      alert("Erro na sincronização: " + err); setCurrentScreen("login");
    } finally { if (typeof unlisten === 'function') unlisten(); }
  };

  const getWindowSizeClass = () => {
    if (currentScreen === "main_panel") return "max-w-5xl"; 
    // Juntamos o email_setup com os contacts para ambos usarem a tela Larga (max-w-4xl)
    if (currentScreen === "contacts" || currentScreen === "email_setup") return "max-w-4xl";   
    if (currentScreen === "settings") return "max-w-3xl";   
    if (currentScreen === "settings_signature" || currentScreen === "settings_auth") return "max-w-2xl"; 
    return "max-w-md"; 
  };
  

  return (
    <main className="w-screen h-screen bg-transparent flex items-center justify-center p-6 text-slate-800 font-sans">
      <AnimatePresence mode="wait">
        
        {/* === SPLASH SCREEN === */}
        {currentScreen === "splash" && (
          <motion.div key="splash" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1, filter: "blur(10px)" }} transition={{ duration: 0.5 }} className="flex flex-col items-center justify-center space-y-4 p-8 bg-white/90 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white">
            <div className="relative w-24 h-24 flex items-center justify-center bg-blue-50 rounded-full shadow-inner border border-blue-100">
              <AnimatePresence mode="wait">
                {splashStep === 0 && <motion.div key="send" initial={{ opacity: 0, x: -20, y: 20 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: 20, y: -20 }}><Send size={40} className="text-blue-500" /></motion.div>}
                {splashStep === 1 && <motion.div key="inbox" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}><Inbox size={40} className="text-indigo-500" /></motion.div>}
                {splashStep === 2 && <motion.div key="process" animate={{ rotate: 180 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }} exit={{ opacity: 0, scale: 0.5 }}><Settings size={40} className="text-emerald-500" /></motion.div>}
              </AnimatePresence>
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">NDD Recovery</h1>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-widest mt-1">
                {splashStep === 0 && "Enviando solicitações..."} {splashStep === 1 && "Aguardando respostas..."} {splashStep === 2 && "Processando inteligência..."}
              </p>
            </div>
          </motion.div>
        )}

        {/* === JANELA PRINCIPAL === */}
        {currentScreen !== "splash" && (
          <motion.div key="app-container" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6 }} className={`w-full ${getWindowSizeClass()} max-h-[96vh] overflow-hidden bg-gradient-to-br ${isDevMode ? 'from-amber-200/90 via-orange-200/70 to-amber-300/90 border-amber-600/50 shadow-amber-950/40' : 'from-blue-50 via-indigo-50/50 to-purple-50 border-white/60 shadow-2xl'} rounded-3xl border overflow-hidden relative transition-all duration-700 ease-in-out`}>            
            {/* Comentários JSX precisam estar AQUI DENTRO para não quebrar a tela */}
            {/* A janela muda de cor globalmente se o Modo Dev estiver ativo! */}
            {/* Incluímos as telas de settings na lista que aciona a janela grande */}

            {/* Marca D'água Global do Modo Dev */}
            {isDevMode && (
              <div className="absolute inset-0 overflow-hidden pointer-events-none z-0 select-none flex items-center justify-center">
                <div className="rotate-[-35deg] text-[150px] font-black text-amber-500/10 whitespace-nowrap">MODO DEV</div>
              </div>
            )}

            {/* CONTROLES DE JANELA (Arraste e Botões) */}
            <div className="h-14 w-full absolute top-0 left-0 z-50 flex">
              <div className="flex-1 h-full hover:cursor-grab active:cursor-grabbing" style={{ WebkitAppRegion: "drag" } as any} />
              <div className="flex items-center px-4 space-x-1 relative z-[100]" style={{ WebkitAppRegion: "no-drag" } as any}>
                <button onClick={() => getCurrentWindow().minimize()} className="p-1 rounded-full text-slate-400 hover:text-blue-500 hover:bg-blue-50 transition-colors pointer-events-auto"><Minus size={18} /></button>
                <button onClick={() => getCurrentWindow().close()} className="p-1 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors pointer-events-auto"><X size={18} /></button>
              </div>
            </div>

            <div className="p-8 pt-12 bg-white/40 backdrop-blur-xl h-full w-full overflow-y-auto scroll-smooth">
              <AnimatePresence mode="wait">
                
                {/* --- TELA DE LOGIN --- */}
                {currentScreen === "login" && (
                  <motion.div key="login" initial={{ opacity: 0, x: -20 }} animate={isShaking ? { x: [-10, 10, -8, 8, -4, 4, 0] } : { opacity: 1, x: 0 }} transition={{ duration: 0.4 }} className="space-y-6">
                    <div className="flex items-center space-x-3 mb-6"><div className="p-2 bg-blue-100 rounded-lg"><Mail className="text-blue-600" size={24} /></div><h2 className="text-2xl font-bold text-slate-800">Acesso Restrito</h2></div>
                    {loginError && (<div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-sm font-medium flex items-center space-x-2"><X size={18} className="text-red-500 shrink-0" /><span>{loginError}</span></div>)}
                    <form onSubmit={handleLogin} className="space-y-4">
                      <div className="space-y-1"><label className="text-xs font-semibold text-slate-500 uppercase ml-1">Provedor NDD</label><div className="relative"><Briefcase className="absolute left-3 top-3 text-slate-400" size={18} /><input type="text" value={provider} onChange={e => setProvider(e.target.value)} required disabled={isAuthenticating} className="w-full bg-white/60 border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm disabled:opacity-50" /></div></div>
                      <div className="space-y-1"><label className="text-xs font-semibold text-slate-500 uppercase ml-1">Email Corporativo</label><div className="relative"><User className="absolute left-3 top-3 text-slate-400" size={18} /><input type="email" value={email} onChange={e => setEmail(e.target.value)} required disabled={isAuthenticating} className="w-full bg-white/60 border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm disabled:opacity-50" /></div></div>
                      <div className="space-y-1"><label className="text-xs font-semibold text-slate-500 uppercase ml-1">Senha</label><div className="relative"><Lock className="absolute left-3 top-3 text-slate-400" size={18} /><input type="password" value={password} onChange={e => setPassword(e.target.value)} required disabled={isAuthenticating} className="w-full bg-white/60 border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm disabled:opacity-50" /></div></div>
                      <button type="submit" disabled={isAuthenticating} className={`w-full mt-6 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-md ${isAuthenticating ? 'bg-indigo-400 cursor-not-allowed' : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 transform hover:scale-[1.02] active:scale-95'}`}>
                        {isAuthenticating ? (<><RefreshCw size={18} className="animate-spin" /><span>Validando credenciais...</span></>) : (<><span>Iniciar Sessão</span><ChevronRight size={18} /></>)}
                      </button>
                    </form>
                  </motion.div>
                )}

                {/* --- TELA DE UPLOAD (DASHBOARD INICIAL) --- */}
                {currentScreen === "dashboard" && (
                  <motion.div key="dashboard" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col items-center justify-center text-center relative w-full h-full min-h-[400px]">
                    {results.length > 0 && (
                      <div className="absolute top-0 left-0">
                        <button onClick={() => setCurrentScreen("main_panel")} className="flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50">
                          <motion.div className="mr-1.5" whileHover={{ x: [0, -2, 2, -2, 2, 0], transition: { duration: 0.5, repeat: Infinity, repeatDelay: 0.5 } }}><ArrowLeft size={18} /></motion.div>Voltar
                        </button>
                      </div>
                    )}
                    <div className="flex flex-col items-center justify-center w-full max-w-md mx-auto mt-6">
                      <h2 className="text-2xl font-bold text-slate-800 mb-2">Base de Contatos</h2>
                      <p className="text-slate-500 text-sm mb-8">Selecione a planilha com os emails dos clientes NDD.</p>
                      <div onClick={handleSelectFile} className={`w-full p-8 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${selectedFile ? 'border-emerald-400 bg-emerald-50 hover:bg-emerald-100' : 'border-slate-300 bg-white/50 hover:bg-white hover:border-blue-400'}`}>
                        {selectedFile ? (
                          <motion.div initial={{ scale: 0.8 }} animate={{ scale: 1 }} className="flex flex-col items-center"><CheckCircle2 size={40} className="text-emerald-500 mb-3" /><p className="text-emerald-700 font-semibold mb-1">Arquivo Pronto</p><p className="text-xs text-slate-500 max-w-xs truncate">{selectedFile}</p></motion.div>
                        ) : (
                          <><UploadCloud size={40} className="text-blue-500 mb-3" /><p className="text-slate-700 font-semibold mb-1">Buscar planilha</p><p className="text-xs text-slate-500">Apenas arquivos .xlsx e .xls</p></>
                        )}
                      </div>
                      {selectedFile && (
                        <motion.button onClick={handleProcessExcel} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full mt-8 bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-md">
                          <FileSpreadsheet size={18} /><span>Processar Base Local</span>
                        </motion.button>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE SINCRONIZAÇÃO --- */}
                {currentScreen === "syncing" && (
                  <motion.div key="syncing" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="flex flex-col items-center justify-center w-full min-h-[380px] p-6 relative">
                    {(syncPhase !== "downloading") && (
                      <div className="absolute top-8 left-0 w-full flex justify-around px-6 z-10">
                        <motion.div layoutId="printers-container" className="flex flex-col items-center text-blue-600">
                          <motion.span layoutId="printers-number" className="text-4xl font-black font-mono tracking-tighter" style={{ fontVariantNumeric: "tabular-nums" }}>{simulatedPrinterCount.toLocaleString('pt-BR')}</motion.span>
                          <motion.span layoutId="printers-text" className="text-[10px] font-bold uppercase tracking-widest mt-1">impressoras</motion.span>
                        </motion.div>
                        <motion.div layoutId="companies-container" className="flex flex-col items-center text-slate-500">
                          <motion.span layoutId="companies-number" className="text-4xl font-black font-mono tracking-tighter" style={{ fontVariantNumeric: "tabular-nums" }}>{simulatedCompanyCount.toLocaleString('pt-BR')}</motion.span>
                          <motion.span layoutId="companies-text" className="text-[10px] font-bold uppercase tracking-widest mt-1">empresas</motion.span>
                        </motion.div>
                      </div>
                    )}
                    <div className={`relative flex items-center justify-center transition-all duration-700 ${syncPhase === "downloading" ? "mb-6 h-28 w-28" : "h-0 w-0 opacity-0 overflow-hidden"}`}>
                      <AnimatePresence mode="wait">
                        {syncPhase === "downloading" && (
                          <motion.div key="gear" exit={{ scale: 0, opacity:0, transition:{duration:0.3} }} className="relative">
                            <Settings size={80} className="text-blue-500 animate-spin relative z-10" />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <AnimatePresence mode="wait">
                      {syncPhase === "downloading" && (
                        <motion.div key="phase1" exit={{ opacity: 0, y: 20 }} className="w-full max-w-sm space-y-4">
                          <div className="text-center">
                            <h2 className="text-xl font-bold text-slate-800">Extraindo Dados NDD</h2>
                            <div className="flex flex-col items-center mt-5 space-y-1">
                              <motion.div layoutId="printers-container" className="flex items-baseline space-x-1.5 text-blue-600">
                                <motion.span layoutId="printers-number" className="text-3xl font-extrabold font-mono tracking-tighter">{printerCount.toLocaleString('pt-BR')}</motion.span>
                                <motion.span layoutId="printers-text" className="text-sm font-bold">impressoras</motion.span>
                              </motion.div>
                              <motion.div layoutId="companies-container" className="flex items-baseline space-x-1.5 text-slate-500">
                                <motion.span layoutId="companies-number" className="text-sm font-bold">{companyCount.toLocaleString('pt-BR')}</motion.span>
                                <motion.span layoutId="companies-text" className="text-sm font-bold">empresas</motion.span>
                              </motion.div>
                            </div>
                          </div>
                          <div className="pt-2">
                            <div className="flex justify-between text-[11px] font-semibold text-slate-500 px-1 pb-1.5"><span className="truncate w-[85%]">{progressMsg}</span><span>{Math.round(progressPercent)}%</span></div>
                            <div className="w-full h-2.5 bg-slate-200/80 rounded-full overflow-hidden shadow-inner relative">
                              <motion.div className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 rounded-full" animate={{ width: `${Math.ceil(progressPercent)}%` }} transition={{ ease: "linear", duration: 0.1 }} />
                            </div>
                          </div>
                        </motion.div>
                      )}

                      {(syncPhase === "transition" || syncPhase === "cleaning") && (
                        <motion.div key="phase2" initial={{opacity:0, y:20}} animate={{opacity:1, y:0, transition:{delay:0.2}}} className="w-full max-w-sm bg-white/70 backdrop-blur-md rounded-xl p-5 shadow-sm border border-slate-200 h-60 flex flex-col relative mt-16 z-0 overflow-hidden">
                          <div className="absolute top-0 left-0 w-full p-3 border-b border-slate-200/60 bg-slate-50/80 flex items-center space-x-2 z-10"><Database size={16} className="text-blue-500" /><span className="text-xs text-slate-500 uppercase tracking-widest font-sans font-bold">Tratamento de Dados</span></div>
                          <div className="flex-1 log-scroll-view text-left mt-8 pr-2 pb-1 relative z-10 font-mono scroll-smooth">
                            {fakeLogs.map((log, i) => (
                              <motion.div key={i} initial={{opacity: 0, x: -5}} animate={{opacity: 1, x: 0}} className={`text-xs mb-4 leading-relaxed flex items-start ${log.isSuccess ? 'text-emerald-600 font-bold' : 'text-slate-600 font-medium'}`}>
                                <span className="text-blue-500 mr-2 shrink-0 mt-[1px]">{'>'}</span>
                                <div className="flex flex-col w-full">
                                  <span><Typewriter text={log.text} />
                                    {i === fakeLogs.length - 1 && syncPhase === "cleaning" && !log.isSuccess && (<motion.div animate={{ opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 0.6 }} className="w-2 h-3.5 bg-blue-500 inline-block ml-1 align-middle" />)}
                                  </span>
                                  {log.drop > 0 && (
                                    <motion.div initial={{ opacity: 0, scale: 0.8, y: -5 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ delay: (log.text.length * 0.015) }} className="text-[10px] text-red-600 font-bold bg-red-50 border border-red-100 px-2 py-1 rounded flex items-center w-fit mt-1.5 shadow-sm">
                                      <Minus size={10} className="mr-1" /> {log.drop.toLocaleString('pt-BR')} impressoras removidas
                                    </motion.div>
                                  )}
                                </div>
                              </motion.div>
                            ))}
                            <div ref={logsEndRef} className="h-1" />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}

                {/* --- TELA PRINCIPAL (HUB DE CONTROLE) --- */}
                {currentScreen === "main_panel" && (
                  <motion.div key="main_panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="w-full relative px-2">
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex items-center justify-between border-b border-slate-200/60 pb-4 mt-2">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-xl shadow-sm"><Database size={24} className="text-white" /></div>
                        <div>
                          <h2 className="text-xl font-extrabold text-slate-800 tracking-tight">Painel de Operações</h2>
                          <p className="text-xs font-semibold text-slate-500">Monitoramento e Automação em Segundo Plano</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <button onClick={async () => {
                          try {
                            const prof: any = await invoke("get_user_profile", { email: email });
                            setProfileName(prof.name || ""); setProfileTitle(prof.title || ""); setProfileDept(prof.department || ""); setProfilePhone(prof.phone || "");
                          } catch(e) { console.warn("Banco virgem, indo para settings."); }
                          setCurrentScreen("settings"); 
                        }} className="text-xs font-bold text-slate-600 hover:text-indigo-600 flex items-center gap-1.5 bg-white/50 px-3 py-1.5 rounded-lg transition-colors border border-slate-200 shadow-sm">
                          <Settings size={14}/> Configurações
                        </button>
                        <div onDoubleClick={() => setIsDevMode(!isDevMode)} className="flex items-center gap-2 cursor-pointer select-none" title="Dê um clique duplo para alternar o Modo Desenvolvedor">
                          <span className="flex h-3 w-3 relative">
                            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isDevMode ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                            <span className={`relative inline-flex rounded-full h-3 w-3 ${isDevMode ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                          </span>
                          <span className={`text-xs font-bold uppercase tracking-wider ${isDevMode ? 'text-amber-600' : 'text-slate-600'}`}>
                            {isDevMode ? 'Modo Dev Ativo' : 'Sistema Online'}
                          </span>
                        </div>
                      </div>
                    </motion.div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                      <div className="md:col-span-5 flex flex-col space-y-4">
                        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Settings size={16} className="text-blue-500"/> Retrato da Base NDD</h3>
                        <motion.div variants={{ hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } } }} initial="hidden" animate="show" className="w-full bg-white/60 p-3 rounded-2xl border border-slate-200 shadow-sm space-y-2">
                          <motion.div layoutId="printers-container" transition={{ type: "spring", stiffness: 80, damping: 15 }} className="bg-white border border-slate-200 p-3 rounded-xl flex justify-between items-center shadow-sm relative z-50">
                            <motion.span layoutId="printers-text" className="text-xs font-semibold text-slate-600">Total impressoras no NDD</motion.span>
                            <motion.span layoutId="printers-number" className="text-lg font-black text-blue-600">{syncStats.total.toLocaleString('pt-BR')}</motion.span>
                          </motion.div>
                          <motion.div layoutId="companies-container" transition={{ type: "spring", stiffness: 80, damping: 15 }} className="bg-white border border-slate-200 p-3 rounded-xl flex justify-between items-center shadow-sm relative z-50">
                            <motion.span layoutId="companies-text" className="text-xs font-semibold text-slate-600">Empresas ativas no NDD</motion.span>
                            <motion.span layoutId="companies-number" className="text-lg font-black text-blue-600">{syncStats.totalCompanies.toLocaleString('pt-BR')}</motion.span>
                          </motion.div>
                          <motion.div variants={{ hidden: { opacity: 0, x: -20 }, show: { opacity: 1, x: 0 } }} className="bg-emerald-50/50 border border-emerald-100 p-2.5 px-3 rounded-xl flex justify-between items-center">
                            <span className="text-[11px] font-semibold text-slate-600">Impressoras online (0 a 7 dias)</span><span className="text-sm font-bold text-emerald-600">{syncStats.online.toLocaleString('pt-BR')}</span>
                          </motion.div>
                          <motion.div variants={{ hidden: { opacity: 0, x: -20 }, show: { opacity: 1, x: 0 } }} className="bg-red-50/50 border border-red-100 p-2.5 px-3 rounded-xl flex justify-between items-center">
                            <span className="text-[11px] font-semibold text-slate-600">Impressoras offline (+ de 7 dias)</span><span className="text-sm font-bold text-red-600">{syncStats.offline.toLocaleString('pt-BR')}</span>
                          </motion.div>
                          <motion.div variants={{ hidden: { opacity: 0, x: -20 }, show: { opacity: 1, x: 0 } }} className="bg-amber-50/50 border border-amber-100 p-2.5 px-3 rounded-xl flex justify-between items-center">
                            <span className="text-[11px] font-semibold text-slate-600">Empresas com equipamentos offline</span><span className="text-sm font-bold text-amber-600">{syncStats.offlineCompanies.toLocaleString('pt-BR')}</span>
                          </motion.div>
                        </motion.div>
                        <div className="flex gap-2">
                          <button onClick={async () => { try { alert("✅ " + await invoke<string>("export_to_excel", { data: results })); } catch (err) { alert("❌ " + err); } }} className="flex-1 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold py-2.5 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-xs">
                            <FileSpreadsheet size={14} className="text-emerald-600"/> Exportar Base
                          </button>
                          <button onClick={() => setCurrentScreen("dashboard")} className="flex-1 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold py-2.5 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-xs">
                            <RefreshCw size={14} className="text-blue-600"/> Reimportar
                          </button>
                        </div>
                      </div>

                      <div className="md:col-span-7 flex flex-col space-y-5">
                        <div className="space-y-3">
                          <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><AlertCircle size={16} className="text-amber-500"/> Pendências e Tarefas</h3>
                          {syncStats.missingEmails > 0 ? (
                            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                              <div><h4 className="font-bold text-amber-800 text-sm">Contatos Faltantes</h4><p className="text-xs text-amber-700/80 mt-0.5 max-w-xs">{syncStats.missingEmails} empresas offline não possuem e-mail cadastrado. A automação não poderá notificá-las.</p></div>
                              <button onClick={async () => { try { await invoke("ensure_contacts_exist", { names: missingCompsArray }); await loadContacts(); setCurrentScreen("contacts"); setIsExpanded(true); setFilterMissingEmail(true); } catch (err) { alert("⚠️ Erro:\n" + err); } }} className="py-2 px-4 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold shadow-md transition-transform hover:scale-105 active:scale-95 flex items-center gap-2 text-xs">
                                Resolver Agora <ChevronRight size={14}/>
                              </button>
                            </div>
                          ) : (
                            <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 shadow-sm flex items-center gap-3">
                              <div className="p-2 bg-emerald-100 rounded-full"><CheckCircle2 size={20} className="text-emerald-600" /></div>
                              <div><h4 className="font-bold text-emerald-800 text-sm">Base Impecável</h4><p className="text-xs text-emerald-700/80 mt-0.5">Todas as empresas offline possuem e-mail. Pronto para automação.</p></div>
                            </div>
                          )}
                        </div>

                        <div className="space-y-3">
                          <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2"><Send size={16} className="text-indigo-500"/> Disparador Automático Gmail</h3>
                          <div className={`bg-white border rounded-2xl p-5 shadow-sm relative overflow-hidden transition-all ${syncStats.missingEmails > 0 ? 'border-amber-200' : 'border-slate-200'}`}>
                            <div className={`absolute top-0 left-0 w-1 h-full ${syncStats.missingEmails > 0 ? 'bg-amber-400' : 'bg-emerald-500'}`}></div>
                            <div className="flex justify-between items-start mb-4">
                              <div>
                                <h4 className="font-bold text-slate-800">Campanha de Recuperação</h4>
                                <p className="text-xs text-slate-500 mt-1">{syncStats.missingEmails > 0 ? `Serão enviados e-mails para ${syncStats.offlineCompanies - syncStats.missingEmails} empresas. (${syncStats.missingEmails} ignoradas).` : `Serão enviados e-mails para todas as ${syncStats.offlineCompanies} empresas offline.`}</p>
                              </div>
                              {syncStats.missingEmails > 0 ? (
                                <span className="px-2.5 py-1 bg-amber-50 text-amber-700 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-amber-200 flex items-center gap-1"><AlertTriangle size={10}/> Envio Parcial</span>
                              ) : (
                                <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-emerald-200 flex items-center gap-1"><CheckCircle2 size={10}/> Pronto para Envio</span>
                              )}
                            </div>
                            <button onClick={async () => {
                              try {
                                const prof: any = await invoke("get_user_profile", { email: email });
                                if (!prof.name || prof.name.trim() === "" || !prof.phone || prof.phone.trim() === "") {
                                  alert("⚠️ AÇÃO REQUERIDA:\n\nSua assinatura de e-mail corporativa ainda não está configurada.\n\nPreencha seus dados em 'Configurações' para garantir que os clientes saibam quem está enviando o aviso.");
                                  setProfileName(prof.name || ""); setProfileTitle(prof.title || ""); setProfileDept(prof.department || ""); setProfilePhone(prof.phone || "");
                                  setCurrentScreen("settings");
                                  return;
                                }
                              } catch(e) { alert("⚠️ Configure sua assinatura primeiro."); setCurrentScreen("settings"); return; }
                              setCurrentScreen("email_setup");
                            }} className="w-full py-3 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold shadow-md transition-all flex items-center justify-center gap-2 text-sm">
                              <SlidersHorizontal size={16}/> Configurar Envio de E-mails
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE CONTATOS --- */}
                {currentScreen === "contacts" && (
                  <motion.div key="contacts" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col h-[600px] w-full">                    <div className="relative flex items-center justify-center mb-6 shrink-0 mt-2">
                      <button onClick={async () => { await recalculateStatsOnReturn(); setEditingContact(null); setCurrentScreen("main_panel"); setIsExpanded(false); }} className="absolute left-0 flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50">
                        <motion.div className="mr-1.5" whileHover={{ x: [0, -2, 2, -2, 2, 0], transition: { duration: 0.5, repeat: Infinity, repeatDelay: 0.5 } }}><ArrowLeft size={18} /></motion.div>Voltar
                      </button>
                      <h2 className="text-xl font-extrabold text-slate-800 tracking-tight">Contatos</h2>
                    </div>

                    {!editingContact && (
                      <div className="flex flex-col gap-3 mb-5 shrink-0">
                        <div className="flex gap-3">
                          {/* --- NOVA BARRA DE PESQUISA --- */}
                          <div className="relative flex-1">
                            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
                            <input 
                              type="text" 
                              value={contactSearchTerm} 
                              onChange={e => setContactSearchTerm(e.target.value)} 
                              placeholder="Buscar empresa, e-mail, contato ou telefone..." 
                              className="w-full h-11 pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none shadow-sm transition-all"
                            />
                          </div>
                          
                          <button onClick={() => setEditingContact({ enterprise_name: "", tel: "", email1: "", email2: "", email3: "", nome1: "", nome2: "", nome3: "", consultor: "", codigo_empresa: "" })} className="h-11 px-5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition-transform hover:scale-[1.02] active:scale-95 shadow-md flex items-center justify-center gap-2 whitespace-nowrap">
                            <Plus size={16}/> Novo Contato
                          </button>
                        </div>

                        <button onClick={() => setFilterMissingEmail(!filterMissingEmail)} className={`w-full h-11 px-4 rounded-xl text-xs font-bold transition-colors border flex items-center justify-center gap-2 shadow-sm hover:shadow-md ${filterMissingEmail ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
                          <AnimatePresence mode="wait">
                            {filterMissingEmail ? (
                              <motion.div key="all" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} className="flex items-center gap-2"><Filter size={16}/> Mostrar Todos os Contatos</motion.div>
                            ) : (
                              <motion.div key="missing" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} className="flex items-center gap-2"><Mail size={16}/> Filtrar: Pendentes de E-mail</motion.div>
                            )}
                          </AnimatePresence>
                        </button>
                      </div>
                    )}

                    <div className="flex-1 overflow-y-auto pr-2 pb-4 space-y-3 scroll-smooth log-scroll-view">
                      {editingContact ? (
                        <div className="bg-white/80 backdrop-blur-md p-6 rounded-2xl border border-slate-200 shadow-lg flex flex-col relative overflow-hidden">
                          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-indigo-500"></div>
                          <input type="text" value={editingContact.enterprise_name} onChange={e => setEditingContact({...editingContact, enterprise_name: e.target.value})} className="text-lg font-extrabold text-slate-800 bg-transparent border-b-2 border-dashed border-slate-300 hover:border-indigo-400 focus:border-indigo-600 focus:border-solid outline-none w-full pb-1.5 transition-colors mb-5" placeholder="Nome Oficial da Empresa..." />
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">E-mail Principal <span className="text-red-500">*</span></label><div className="relative"><Mail size={14} className="absolute left-3 top-3 text-slate-400" /><input type="email" value={editingContact.email1} onChange={e => setEditingContact({...editingContact, email1: e.target.value})} className={`w-full pl-9 p-2.5 bg-slate-50 border rounded-xl text-sm focus:bg-white focus:ring-2 outline-none transition-all shadow-inner ${!editingContact.email1 ? 'border-red-300 focus:ring-red-500' : 'border-slate-200 focus:ring-indigo-500'}`} placeholder="contato@empresa.com" required /></div></div>
                            <div className="space-y-1"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Telefone</label><div className="relative"><Phone size={14} className="absolute left-3 top-3 text-slate-400" /><input type="text" value={editingContact.tel} onChange={e => setEditingContact({...editingContact, tel: formatPhone(e.target.value)})} className="w-full pl-9 p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all shadow-inner" placeholder="(00) 00000-0000" /></div></div>
                            <div className="space-y-1"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Nome do Responsável</label><div className="relative"><User size={14} className="absolute left-3 top-3 text-slate-400" /><input type="text" value={editingContact.nome1} onChange={e => setEditingContact({...editingContact, nome1: e.target.value})} className="w-full pl-9 p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all shadow-inner" placeholder="Ex: João Silva" /></div></div>
                            <div className="space-y-1"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Consultor</label><div className="relative"><Briefcase size={14} className="absolute left-3 top-3 text-slate-400" /><input type="text" value={editingContact.consultor} onChange={e => setEditingContact({...editingContact, consultor: e.target.value})} className="w-full pl-9 p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all shadow-inner" placeholder="Nome do Consultor" /></div></div>
                          </div>
                          <details className="group mt-5" open={Boolean(editingContact.email2 || editingContact.email3 || editingContact.nome2 || editingContact.nome3 || editingContact.codigo_empresa)}>
                            <summary className="text-xs font-bold text-indigo-600 cursor-pointer list-none flex items-center justify-center gap-2 transition-colors p-3 bg-indigo-50/70 border border-indigo-100 rounded-xl hover:bg-indigo-100 w-full shadow-sm"><Plus size={16} className="group-open:hidden" /><Minus size={16} className="hidden group-open:block" /><span className="group-open:hidden">Adicionar mais um contato a esta empresa</span><span className="hidden group-open:inline">Ocultar contatos adicionais</span></summary>
                            <div className="grid grid-cols-2 gap-4 mt-3 p-4 bg-slate-50/50 border border-slate-100 rounded-xl">
                              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">E-mail 2</label><input type="email" value={editingContact.email2} onChange={e => setEditingContact({...editingContact, email2: e.target.value})} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm focus:border-indigo-400 outline-none transition-all shadow-sm" /></div>
                              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Nome 2</label><input type="text" value={editingContact.nome2} onChange={e => setEditingContact({...editingContact, nome2: e.target.value})} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm focus:border-indigo-400 outline-none transition-all shadow-sm" /></div>
                              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">E-mail 3</label><input type="email" value={editingContact.email3} onChange={e => setEditingContact({...editingContact, email3: e.target.value})} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm focus:border-indigo-400 outline-none transition-all shadow-sm" /></div>
                              <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Nome 3</label><input type="text" value={editingContact.nome3} onChange={e => setEditingContact({...editingContact, nome3: e.target.value})} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-sm focus:border-indigo-400 outline-none transition-all shadow-sm" /></div>
                            </div>
                          </details>
                          <div className="flex gap-3 pt-4 mt-4 border-t border-slate-100">
                            {editingContact.id && (
                              <button onClick={async () => { if(confirm(`Excluir contatos da ${editingContact.enterprise_name}?`)) { try { await invoke("delete_contact", { id: editingContact.id }); setEditingContact(null); loadContacts(); } catch (err) { alert("Erro: " + err); } } }} className="px-4 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 hover:border-red-300 py-3 rounded-xl text-sm font-bold transition-transform hover:scale-[1.02] active:scale-95 flex items-center gap-2 shadow-sm" title="Excluir Contato"><Trash2 size={18}/> <span className="hidden sm:inline">Excluir</span></button>
                            )}
                            <button disabled={!editingContact.email1 || editingContact.email1.trim() === ""} onClick={async () => { await invoke("save_contact", { contact: editingContact }); setEditingContact(null); loadContacts(); }} className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all shadow-md flex items-center justify-center gap-2 ${(!editingContact.email1 || editingContact.email1.trim() === "") ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white hover:scale-[1.02] active:scale-95 hover:shadow-lg'}`}><CheckCircle2 size={18}/> Salvar Contato</button>
                            <button onClick={() => setEditingContact(null)} className="px-6 bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 hover:border-slate-300 py-3 rounded-xl text-sm font-bold transition-transform hover:scale-[1.02] active:scale-95 shadow-sm">Cancelar</button>
                          </div>
                        </div>
                      ) : (
                        contacts.filter(c => {
                          // 1. Filtro do botão "Pendentes de Email"
                          if (filterMissingEmail && c.email1 && c.email1.trim() !== "") return false;
                          // 2. Filtro da Barra de Pesquisa (Busca em tudo de forma minúscula)
                          if (contactSearchTerm.trim() !== "") {
                            const term = contactSearchTerm.toLowerCase();
                            const searchableData = `${c.enterprise_name} ${c.email1} ${c.tel} ${c.nome1} ${c.consultor}`.toLowerCase();
                            if (!searchableData.includes(term)) return false;
                          }
                          return true;
                        }).map(c => (
                          <motion.div whileHover={{ y: -2, boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)" }} key={c.id} onClick={() => setEditingContact(c)} className="p-4 bg-white/60 backdrop-blur-sm border border-slate-200 rounded-xl cursor-pointer hover:border-indigo-400 hover:bg-white transition-all group flex flex-col relative overflow-hidden">
                            <div className="absolute left-0 top-0 h-full w-1 bg-transparent group-hover:bg-indigo-400 transition-colors"></div>
                            <p className="font-extrabold text-sm text-slate-800 group-hover:text-indigo-700 transition-colors leading-tight mb-1">{c.enterprise_name}</p>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2">
                              <div className={`text-xs font-semibold flex items-center gap-1.5 px-2 py-0.5 rounded-md ${c.email1 && c.email1.trim() !== "" ? 'bg-slate-100 text-slate-600' : 'bg-red-50 text-red-600 border border-red-100'}`}>
                                {c.email1 && c.email1.trim() !== "" ? (<><Mail size={12}/> {c.email1}</>) : (<><AlertTriangle size={12}/> Sem e-mail</>)}
                              </div>
                              {c.nome1 && <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5"><User size={12}/> {c.nome1}</div>}
                              {c.tel && <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5"><Phone size={12}/> {c.tel}</div>}
                            </div>
                          </motion.div>
                        ))
                      )}
                      
                      {!editingContact && contacts.filter(c => filterMissingEmail ? !c.email1 || c.email1.trim() === "" : true).length === 0 && (
                        <div className="flex flex-col items-center justify-center py-10 opacity-60">
                          <CheckCircle2 size={40} className="text-emerald-500 mb-3" />
                          <p className="text-sm text-slate-600 font-bold">Nenhum contato pendente de e-mail!</p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE CONFIGURAÇÃO DE DISPARO (PENTE FINO) --- */}
                {currentScreen === "email_setup" && (
                  <motion.div key="email_setup" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col h-[600px] w-full relative">
                    <div className="relative flex items-center justify-center mb-6 shrink-0 mt-2">
                      <button onClick={() => setCurrentScreen("main_panel")} className="absolute left-0 flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50">
                        <motion.div className="mr-1.5" whileHover={{ x: [0, -2, 2, -2, 2, 0], transition: { duration: 0.5, repeat: Infinity, repeatDelay: 0.5 } }}><ArrowLeft size={18} /></motion.div> Voltar
                      </button>
                      <h2 className="text-xl font-extrabold text-slate-800 tracking-tight">Setup da Campanha</h2>
                    </div>

                    {/* MÁGICA DO LAYOUT: Grid Dividindo a tela em Esquerda (Config) e Direita (Resumo/Ação) */}
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 flex-1 min-h-0">
                      
                      {/* --- COLUNA ESQUERDA: CONTROLES --- */}
                      <div className="md:col-span-7 flex flex-col space-y-6 overflow-y-auto pr-2 pb-2 log-scroll-view">
                        
                        {/* Critério de Inatividade */}
                        <div className="bg-white/60 backdrop-blur-sm border border-slate-200 p-5 rounded-3xl shadow-sm">
                          <div className="flex justify-between items-end mb-4">
                            <div>
                              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><Settings size={16} className="text-blue-500"/> Critério de Inatividade</h3>
                              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">A partir de quantos dias sem comunicação devemos notificar o cliente?</p>
                            </div>
                            <span className="text-2xl font-black text-indigo-600 font-mono bg-indigo-50 px-3 py-1 rounded-xl border border-indigo-100">{offlineDaysThreshold} <span className="text-sm text-indigo-400 font-bold">dias</span></span>
                          </div>
                          <input type="range" min="1" max="30" value={offlineDaysThreshold} onChange={(e) => setOfflineDaysThreshold(Number(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-500 transition-all mt-2" />
                          <div className="flex justify-between text-[10px] font-bold text-slate-400 mt-3 uppercase tracking-widest"><span>1 Dia</span><span>15 Dias</span><span>30 Dias</span></div>
                        </div>

                        {/* Escopo da Notificação */}
                        <div className="flex flex-col flex-1">
                          <h3 className="text-sm font-bold text-slate-800 mb-3 ml-1">Escopo da Notificação</h3>
                          <div className="grid grid-cols-2 gap-4 flex-1">
                            <div onClick={() => setSendToHostOffline(!sendToHostOffline)} className={`relative p-5 border-2 rounded-2xl cursor-pointer transition-all flex flex-col items-start ${sendToHostOffline ? 'border-indigo-500 bg-indigo-50/50 shadow-md' : 'border-slate-200 bg-white/50 hover:border-slate-300 opacity-70 hover:opacity-100'}`}>
                              {sendToHostOffline && <div className="absolute top-4 right-4"><CheckCircle2 size={20} className="text-indigo-600"/></div>}
                              <div className={`p-2.5 rounded-xl mb-3 ${sendToHostOffline ? 'bg-indigo-100' : 'bg-slate-100'}`}><Server size={22} className={sendToHostOffline ? 'text-indigo-600' : 'text-slate-500'}/></div>
                              <h4 className="font-bold text-slate-800 text-sm leading-tight">Servidor Offline<br/>(NDD Host)</h4>
                              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Notificar empresas onde <b>todas</b> as impressoras caíram.</p>
                            </div>
                            <div onClick={() => setSendToPrinterOffline(!sendToPrinterOffline)} className={`relative p-5 border-2 rounded-2xl cursor-pointer transition-all flex flex-col items-start ${sendToPrinterOffline ? 'border-blue-500 bg-blue-50/50 shadow-md' : 'border-slate-200 bg-white/50 hover:border-slate-300 opacity-70 hover:opacity-100'}`}>
                              {sendToPrinterOffline && <div className="absolute top-4 right-4"><CheckCircle2 size={20} className="text-blue-600"/></div>}
                              <div className={`p-2.5 rounded-xl mb-3 ${sendToPrinterOffline ? 'bg-blue-100' : 'bg-slate-100'}`}><Printer size={22} className={sendToPrinterOffline ? 'text-blue-600' : 'text-slate-500'}/></div>
                              <h4 className="font-bold text-slate-800 text-sm leading-tight">Impressoras<br/>Isoladas</h4>
                              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">Notificar empresas onde <b>apenas algumas</b> máquinas caíram.</p>
                            </div>
                          </div>
                        </div>

                      </div>

                      {/* --- COLUNA DIREITA: RESUMO E AÇÃO --- */}
                      <div className="md:col-span-5 flex flex-col justify-between bg-white/40 border border-slate-200 rounded-3xl p-5 relative overflow-hidden">
                        
                        <div className="space-y-4 relative z-10">
                          {/* Mostrador Dinâmico Duplo */}
                          <motion.div layout className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100/60 rounded-2xl p-5 shadow-sm">
                            <h4 className="font-extrabold text-indigo-900 text-sm flex items-center gap-2 mb-4"><Send size={16} className="text-indigo-600"/> Resumo de Disparos</h4>
                            <div className="flex justify-between items-center bg-white/60 p-4 rounded-xl border border-white">
                              <div className="flex flex-col items-center">
                                <span className="text-3xl font-black text-indigo-500 leading-none">{dispatchPreview.printers}</span>
                                <span className="text-[10px] font-bold text-indigo-400 mt-1 uppercase tracking-widest">Impressoras</span>
                              </div>
                              <div className="h-10 w-[1px] bg-indigo-200/50"></div>
                              <div className="flex flex-col items-center">
                                <span className="text-4xl font-black text-indigo-600 leading-none">{dispatchPreview.emails}</span>
                                <span className="text-[10px] font-bold text-indigo-400 mt-1 uppercase tracking-widest">E-mails Totais</span>
                              </div>
                            </div>
                          </motion.div>

                          {/* Monitor de Transmissão (Terminal) */}
                          <AnimatePresence>
                            {(isSendingEmail || emailDispatchLogs.length > 0) && (
                              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 180 }} exit={{ opacity: 0, height: 0 }} className="bg-slate-900 border border-slate-700/60 rounded-xl p-4 shadow-inner flex flex-col">
                                <div className="flex justify-between items-center pb-2 border-b border-slate-700/60 mb-3 shrink-0">
                                  <div className="flex gap-1.5 items-center"><Terminal size={14} className="text-emerald-400"/> <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Terminal</span></div>
                                </div>
                                <div className="flex-1 log-scroll-view text-left space-y-2 pr-2 pb-1 font-mono text-[10px] scroll-smooth">
                                  {emailDispatchLogs.map((log, i) => (
                                    <motion.div key={i} initial={{ opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }} className={`leading-relaxed ${log.type === 'error' ? 'text-red-400' : (log.type === 'success' ? 'text-emerald-400' : 'text-slate-300')}`}>
                                      <span className="text-emerald-600 mr-2 shrink-0">{'>'}</span>{log.msg}
                                    </motion.div>
                                  ))}
                                  <div ref={logsEndRef} className="h-1" />
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* Botão Fixo na Parte Inferior da Coluna */}
                        <div className="pt-4 mt-4 relative z-10">
                          {isDevMode && (<div className="absolute -top-7 left-0 w-full flex justify-center"><span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-3 py-1 rounded-t-xl border border-amber-200 border-b-0 flex items-center gap-1 shadow-sm"><Bot size={12}/> Redirecionando para: {email}</span></div>)}
                          <button 
                            disabled={(!sendToHostOffline && !sendToPrinterOffline) || !gmailPassword || isSendingEmail || dispatchPreview.emails === 0}
                            onClick={async () => {
                              if (!geminiKey || geminiKey.trim() === "") { alert("⚠️ A Chave Gemini não está configurada. Vá em Configurações!"); return; }
                              if (!gmailPassword || gmailPassword.trim() === "") { alert("⚠️ A Senha do Gmail não está configurada. Vá em Configurações!"); return; }

                              setIsSendingEmail(true); setEmailDispatchLogs([]); 
                              
                              const unlisten = await listen<string>("email-dispatch-event", (event) => {
                                const msg = event.payload;
                                let type: 'info' | 'success' | 'error' = 'info';
                                if (msg.includes("✅")) type = 'success';
                                if (msg.includes("❌")) type = 'error';
                                setEmailDispatchLogs(prev => [...prev, { msg, type }]);
                              });
                              
                              try {
                                const resposta = await invoke<string>("process_and_send_emails", { 
                                  userEmail: email, userPass: gmailPassword.replace(/\s+/g, ''), geminiKey: geminiKey.trim(), offlineDaysThreshold, sendToHostOffline, sendToPrinterOffline, isDevMode, data: results 
                                });
                                alert(`✅ SUCESSO!\n\n${resposta}`);
                              } catch (err) { setEmailDispatchLogs(prev => [...prev, { msg: `❌ ERRO: ${err}`, type: 'error' }]);
                              } finally { setIsSendingEmail(false); if (typeof unlisten === 'function') unlisten(); }
                            }}
                            className={`w-full py-4 rounded-xl font-extrabold shadow-lg transition-transform flex items-center justify-center gap-2 text-sm relative z-10 ${(!sendToHostOffline && !sendToPrinterOffline) || !gmailPassword || isSendingEmail || dispatchPreview.emails === 0 ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : (isDevMode ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:scale-[1.02] active:scale-95' : 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:scale-[1.02] active:scale-95')}`}
                          >
                            {isSendingEmail ? <RefreshCw size={18} className="animate-spin" /> : <Send size={18}/>} 
                            {isSendingEmail ? 'Disparando...' : (isDevMode ? `TESTE DEV: Enviar ${dispatchPreview.emails} E-mails` : `Processar ${dispatchPreview.emails} Disparos`)}
                          </button>
                        </div>
                      </div>

                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE CONFIGURAÇÕES (HUB DE CARDS) --- */}
                {currentScreen === "settings" && (
                  <motion.div key="settings" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col h-[600px] w-full relative">                    <div className="relative flex items-center justify-center mb-8 mt-2">
                      <button onClick={() => setCurrentScreen("main_panel")} className="absolute left-0 flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg">
                        <ArrowLeft size={18} className="mr-1.5" /> Voltar
                      </button>
                      <h2 className="text-xl font-extrabold text-slate-800">Centro de Configurações</h2>
                    </div>

                    {/* OS CARDS INTELIGENTES (Em grid para ocupar a janela média-grande) */}
                    <div className="grid grid-cols-2 gap-6 flex-1">
                      
                      {/* CARD 1: ASSINATURA DE E-MAIL (100% Clicável) */}
                      <motion.div 
                        onClick={() => setCurrentScreen("settings_signature")}
                        whileHover={{ y: -3, boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)" }} 
                        className="bg-white/70 p-5 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-start text-left transition-all cursor-pointer hover:border-indigo-400 hover:bg-white group"
                      >
                        <div className="p-2.5 bg-blue-100 rounded-2xl mb-3 border border-blue-200/70 transition-colors group-hover:bg-blue-50"><User size={20} className="text-blue-600"/></div>
                        <h3 className="font-extrabold text-slate-800 text-base transition-colors group-hover:text-indigo-700">Assinatura Corporativa</h3>
                        <p className="text-xs text-slate-600 mt-1 mb-4 leading-relaxed flex-1">Configure seus dados pessoais para montar a assinatura no final dos e-mails.</p>
                        
                        <div className="text-xs font-bold text-indigo-600 flex items-center gap-1.5 transition-all p-2 rounded-lg group-hover:bg-indigo-50 group-hover:gap-2">
                          Acessar Configurações <ChevronRight size={14}/>
                        </div>
                      </motion.div>

                      {/* CARD 2: AUTENTICAÇÃO E IA (100% Clicável) */}
                      <motion.div 
                        onClick={() => setCurrentScreen("settings_auth")}
                        whileHover={{ y: -3, boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)" }} 
                        className="bg-white/70 p-5 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-start text-left transition-all relative overflow-hidden cursor-pointer hover:border-emerald-400 hover:bg-white group"
                      >
                        <div className="p-2.5 bg-emerald-100 rounded-2xl mb-3 border border-emerald-200/70 transition-colors group-hover:bg-emerald-50"><Lock size={20} className="text-emerald-600"/></div>
                        <h3 className="font-extrabold text-slate-800 text-base transition-colors group-hover:text-emerald-700">Autenticação e Motores IA</h3>
                        <p className="text-xs text-slate-600 mt-1 mb-4 leading-relaxed flex-1 relative z-10">Gerencie a Senha de App do Gmail e a chave da API do Google Gemini.</p>
                        
                        <div className="text-xs font-bold text-emerald-600 flex items-center gap-1.5 transition-all p-2 rounded-lg group-hover:bg-emerald-50 group-hover:gap-2 relative z-10">
                          Gerenciar Chaves <ChevronRight size={14}/>
                        </div>
                        
                        {/* Efeito extra: o robô dá um leve zoom e gira ao passar o mouse no card! */}
                        <Bot size={60} className="absolute -bottom-4 -right-4 text-emerald-100 opacity-70 rotate-[-15deg] transition-transform duration-500 group-hover:scale-110 group-hover:-rotate-12"/>
                      </motion.div>

                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE ASSINATURA --- */}
                {currentScreen === "settings_signature" && (
                  <motion.div key="settings_signature" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col h-[600px] w-full relative">
                    <div className="relative flex items-center justify-center mb-8 shrink-0 mt-2">
                      <button onClick={() => setCurrentScreen("settings")} className="absolute left-0 flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg">
                        <ArrowLeft size={18} className="mr-1.5" /> Voltar
                      </button>
                      <h2 className="text-xl font-extrabold text-slate-800 tracking-tight flex items-center gap-2.5"><User size={18} className="text-blue-500"/> Configuração de Assinatura</h2>
                    </div>

                    <div className="flex-1 bg-white/60 p-8 rounded-3xl border border-slate-200 shadow-sm overflow-y-auto space-y-4">
                      <p className="text-sm text-slate-600 mb-6">Esses dados serão usados para montar automaticamente a sua assinatura da Canon do Brasil (borda vermelha CID) no final de cada e-mail disparado pela sua conta (<b>{email}</b>).</p>
                      <div className="space-y-1"><label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Nome Completo</label><input type="text" value={profileName} onChange={e => setProfileName(e.target.value)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="Ex: Daniel Antonio da Cunha" /></div>
                      <div className="space-y-1"><label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Cargo</label><input type="text" value={profileTitle} onChange={e => setProfileTitle(e.target.value)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="Ex: Técnico P&B Sênior" /></div>
                      <div className="space-y-1"><label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Departamento</label><input type="text" value={profileDept} onChange={e => setProfileDept(e.target.value)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="Ex: Departamento de Projetos" /></div>
                      <div className="space-y-1"><label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Celular Corporativo</label><input type="text" value={profilePhone} onChange={e => setProfilePhone(formatPhone(e.target.value))} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="+55 11 99999-9999" /></div>
                      <button onClick={async () => {
                        try {
                          await invoke("save_user_profile", { profile: { email, name: profileName, title: profileTitle, department: profileDept, phone: profilePhone } });
                          alert("Assinatura corporativa salva com sucesso!"); setCurrentScreen("settings");
                        } catch(e) { alert("Erro ao salvar: " + e); }
                      }} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold mt-8 shadow-md transition-transform hover:scale-[1.02] active:scale-95">
                        Salvar Minha Assinatura
                      </button>
                    </div>
                  </motion.div>
                )}

                {/* --- TELA DE AUTENTICAÇÃO --- */}
                {currentScreen === "settings_auth" && (
                  <motion.div key="settings_auth" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="flex flex-col h-[600px] w-full relative">
                    <div className="relative flex items-center justify-center mb-8 shrink-0 mt-2">
                      <button onClick={() => setCurrentScreen("settings")} className="absolute left-0 flex items-center text-slate-400 hover:text-indigo-600 font-bold text-sm transition-colors px-2 py-1 rounded-lg">
                        <ArrowLeft size={18} className="mr-1.5" /> Voltar
                      </button>
                      <h2 className="text-xl font-extrabold text-slate-800 tracking-tight flex items-center gap-2.5"><Lock size={18} className="text-emerald-500"/> Chaves e Segurança</h2>
                    </div>

                    <div className="flex-1 bg-white/60 p-8 rounded-3xl border border-slate-200 shadow-sm overflow-y-auto space-y-5">
                      <p className="text-sm text-slate-600 mb-6 leading-relaxed">Gerencie as suas credenciais de autenticação CID do Gmail e o motor de geração orgânica IA Gemini. Essas chaves nascem ocultas e bloqueadas por segurança. Use o ícone do lápis para editar.</p>
                      
                      <div className="space-y-1">
                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Senha de App CID (Gmail)</label>
                        <div className="relative border border-slate-200 rounded-xl bg-slate-50 flex items-center pr-3 group focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-600 transition-all">
                          <Lock className="absolute left-3 text-slate-400" size={16} />
                          <input type={isGmailPassVisible ? "text" : "password"} value={gmailPassword} onChange={e => setGmailPassword(e.target.value)} readOnly={!isEditingGmailPass} className="flex-1 pl-9 p-3 bg-transparent rounded-xl text-sm outline-none transition-all font-mono placeholder:font-sans placeholder:text-slate-300" placeholder="abcd efgh ijkl mnop" />
                          <div className="flex items-center gap-1.5 shrink-0 ml-2">
                            {!isEditingGmailPass ? (
                              <button onClick={() => setIsEditingGmailPass(true)} className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Editar este campo"><Pencil size={14} /></button>
                            ) : (
                              <button onClick={() => setIsEditingGmailPass(false)} className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded" title="Cancelar edição"><X size={14} /></button>
                            )}
                            <button onClick={() => setIsGmailPassVisible(!isGmailPassVisible)} disabled={!isEditingGmailPass} className={`p-1 rounded transition-colors ${!isEditingGmailPass ? 'opacity-30 cursor-not-allowed text-slate-300' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`} title={isGmailPassVisible ? "Ocultar senha" : "Ver senha"}>
                              {isGmailPassVisible ? <EyeOff size={14}/> : <Eye size={14}/>}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Chave da API (Google Gemini)</label>
                        <div className="relative border border-slate-200 rounded-xl bg-slate-50 flex items-center pr-3 group focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-purple-600 transition-all">
                          <Bot className="absolute left-3 text-slate-400" size={16} />
                          <input type={isGeminiKeyVisible ? "text" : "password"} value={geminiKey} onChange={e => setGeminiKey(e.target.value)} readOnly={!isEditingGeminiKey} className="flex-1 pl-9 p-3 bg-transparent rounded-xl text-sm outline-none transition-all font-mono placeholder:font-sans placeholder:text-slate-300" placeholder="AIzaSy..." />
                          <div className="flex items-center gap-1.5 shrink-0 ml-2">
                            {!isEditingGeminiKey ? (
                              <button onClick={() => setIsEditingGeminiKey(true)} className="p-1 text-slate-400 hover:text-purple-600 hover:bg-purple-50 rounded" title="Editar este campo"><Pencil size={14} /></button>
                            ) : (
                              <button onClick={() => setIsEditingGeminiKey(false)} className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded" title="Cancelar edição"><X size={14} /></button>
                            )}
                            <button onClick={() => setIsGeminiKeyVisible(!isGeminiKeyVisible)} disabled={!isEditingGeminiKey} className={`p-1 rounded transition-colors ${!isEditingGeminiKey ? 'opacity-30 cursor-not-allowed text-slate-300' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`} title={isGeminiKeyVisible ? "Ocultar chave" : "Ver chave"}>
                              {isGeminiKeyVisible ? <EyeOff size={14}/> : <Eye size={14}/>}
                            </button>
                          </div>
                        </div>
                      </div>
                      
                      <button onClick={async () => {
                        try {
                          localStorage.setItem("gmailPassword", gmailPassword);
                          localStorage.setItem("geminiKey", geminiKey);
                          await invoke("save_user_profile", { profile: { email, name: profileName, title: profileTitle, department: profileDept, phone: profilePhone } });
                          setIsEditingGmailPass(false); setIsGmailPassVisible(false);
                          setIsEditingGeminiKey(false); setIsGeminiKeyVisible(false);
                          alert("Chaves de autenticação e IA salvas com sucesso!"); 
                          setCurrentScreen("settings");
                        } catch(e) { alert("Erro ao salvar: " + e); }
                      }} className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white rounded-xl font-bold mt-8 shadow-md transition-transform hover:scale-[1.02] active:scale-95">
                        Salvar Credenciais
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}