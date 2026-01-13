
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION, Message } from './types';

// Utilitaires de décodage/encodage requis par les règles de l'API Live
function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const outCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const transcriptRef = useRef({ input: '', output: '' });

  const stopSession = () => {
    setIsActive(false);
    setIsConnecting(false);
    if (audioContextRef.current) audioContextRef.current.close();
    if (outCtxRef.current) outCtxRef.current.close();
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e){} });
    sourcesRef.current.clear();
    sessionRef.current = null;
  };

  const startSession = async () => {
    if (isConnecting || isActive) return;
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
              })).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message) => {
            if (message.serverContent?.outputTranscription) {
              transcriptRef.current.output += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              transcriptRef.current.input += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (transcriptRef.current.input) setMessages(p => [...p, { role: 'user', text: transcriptRef.current.input }]);
              if (transcriptRef.current.output) setMessages(p => [...p, { role: 'assistant', text: transcriptRef.current.output }]);
              transcriptRef.current = { input: '', output: '' };
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outCtxRef.current) {
              const ctx = outCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e){} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: stopSession,
          onclose: stopSession
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (error) {
      console.error(error);
      setIsConnecting(false);
      stopSession();
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-5xl mx-auto p-4 md:p-10">
      <header className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-2xl font-black shadow-lg shadow-indigo-500/20">
            D
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">Donovan</h1>
            <p className="text-slate-400 text-sm font-medium">Assistant Personnel de Kylian Perrault</p>
          </div>
        </div>
        <div className="glass px-4 py-2 rounded-full flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
            {isActive ? 'En ligne' : 'Déconnecté'}
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col gap-8 min-h-0">
        <div className="relative flex-1 rounded-[2.5rem] glass flex flex-col items-center justify-center p-12 transition-all border-white/5">
          {!isActive && !isConnecting ? (
            <div className="text-center space-y-8 max-w-lg">
              <div className="w-28 h-28 mx-auto rounded-full bg-slate-900 border border-white/10 flex items-center justify-center text-5xl shadow-2xl">
                🎙️
              </div>
              <div className="space-y-4">
                <h2 className="text-3xl font-bold text-white">Prêt pour un échange ?</h2>
                <p className="text-slate-400 text-lg leading-relaxed">
                  "Bonjour, je suis Donovan, l'assistant de Kylian, que voulez-vous savoir à propos de lui ?"
                </p>
              </div>
              <button
                onClick={startSession}
                className="w-full py-5 bg-white text-slate-950 hover:bg-slate-200 rounded-2xl font-bold text-xl transition-all transform hover:-translate-y-1 active:scale-95 shadow-2xl shadow-white/10"
              >
                Lancer la conversation
              </button>
            </div>
          ) : isConnecting ? (
            <div className="flex flex-col items-center gap-6">
              <div className="w-20 h-20 border-[6px] border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-xl font-medium text-slate-300 animate-pulse">Connexion à Donovan...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full w-full">
               <div className="w-64 h-64 rounded-full border-2 border-white/5 flex items-center justify-center relative">
                  <div className="absolute inset-0 rounded-full border border-indigo-500/30 pulse" style={{animationDelay: '0.2s'}} />
                  <div className="absolute inset-4 rounded-full border border-purple-500/20 pulse" />
                  <div className="w-44 h-44 rounded-full bg-gradient-to-b from-slate-800 to-slate-900 flex items-center justify-center shadow-inner border border-white/10">
                    <div className="flex gap-1.5 items-end h-10">
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className="w-1.5 bg-indigo-500 rounded-full animate-bounce" style={{height: `${Math.random()*100}%`, animationDuration: `${0.5 + Math.random()}s`}} />
                      ))}
                    </div>
                  </div>
               </div>
               <div className="mt-12 text-center space-y-2">
                 <p className="text-2xl font-bold text-white tracking-tight">Donovan vous écoute</p>
                 <p className="text-slate-500 font-medium italic">Posez vos questions sur le parcours de Kylian</p>
               </div>
               
               <button
                  onClick={stopSession}
                  className="mt-12 px-10 py-3 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white border border-red-500/20 rounded-2xl transition-all font-bold"
                >
                  Raccrocher
                </button>
            </div>
          )}
        </div>

        {messages.length > 0 && (
          <div className="h-48 glass rounded-[2rem] p-6 overflow-y-auto space-y-4 border-white/5">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-5 py-3 rounded-2xl ${
                  m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'
                }`}>
                  <p className="text-[9px] font-black uppercase tracking-widest opacity-40 mb-1">
                    {m.role === 'user' ? 'Recruteur' : 'Donovan'}
                  </p>
                  <p className="text-sm leading-relaxed">{m.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-4 pb-4">
        {[
          { label: 'Secteur', val: 'Web3 & Luxe' },
          { label: 'Formation', val: 'Inseec Paris' },
          { label: 'Alternance', val: 'Paymium' },
          { label: 'Projet', val: 'Kryptosphère' }
        ].map((item, idx) => (
          <div key={idx} className="glass py-4 px-6 rounded-2xl border-white/5">
            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">{item.label}</p>
            <p className="text-sm font-bold text-slate-200 truncate">{item.val}</p>
          </div>
        ))}
      </footer>
    </div>
  );
};

export default App;
