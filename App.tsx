
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION, Message } from './types';

// Manual implementation of encode/decode as required
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
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
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const currentTranscriptionRef = useRef({ input: '', output: '' });

  const startSession = async () => {
    if (isConnecting || isActive) return;
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: (process.env as any).API_KEY });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log('Session opened');
            setIsActive(true);
            setIsConnecting(false);
            
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              
              sessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcriptions
            if (message.serverContent?.outputTranscription) {
              currentTranscriptionRef.current.output += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentTranscriptionRef.current.input += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const input = currentTranscriptionRef.current.input;
              const output = currentTranscriptionRef.current.output;
              if (input) setMessages(prev => [...prev, { role: 'user', text: input }]);
              if (output) setMessages(prev => [...prev, { role: 'assistant', text: output }]);
              currentTranscriptionRef.current = { input: '', output: '' };
            }

            // Handle Audio
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
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
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            stopSession();
          },
          onclose: () => {
            console.log('Session closed');
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (error) {
      console.error('Failed to start session:', error);
      setIsConnecting(false);
    }
  };

  const stopSession = () => {
    setIsActive(false);
    setIsConnecting(false);
    audioContextRef.current?.close();
    outputAudioContextRef.current?.close();
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto p-4 md:p-8">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center text-xl font-bold">
            D
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Donovan</h1>
            <p className="text-slate-400 text-sm">Assistant de Kylian Perrault</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isActive && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
          <span className="text-xs font-medium text-slate-400 uppercase tracking-widest">
            {isActive ? 'En ligne' : 'Déconnecté'}
          </span>
        </div>
      </header>

      {/* Main Experience */}
      <main className="flex-1 flex flex-col gap-6 overflow-hidden">
        {/* Visualizer Area */}
        <div className="relative flex-1 rounded-3xl overflow-hidden glass flex flex-col items-center justify-center p-8 transition-all">
          {!isActive && !isConnecting ? (
            <div className="text-center space-y-6 max-w-md">
              <div className="w-24 h-24 mx-auto rounded-full bg-slate-800 flex items-center justify-center text-4xl mb-4">
                🎙️
              </div>
              <h2 className="text-2xl font-semibold">Parlez avec Donovan</h2>
              <p className="text-slate-400">
                Bonjour, je suis Donovan, l'assistant de Kylian, que voulez-vous savoir à propos de lui ?
              </p>
              <button
                onClick={startSession}
                className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-full font-bold transition-all transform hover:scale-105 active:scale-95 shadow-xl shadow-indigo-500/20"
              >
                Commencer la conversation
              </button>
            </div>
          ) : isConnecting ? (
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-slate-400 animate-pulse">Initialisation de l'assistant...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full w-full">
               <div className="w-48 h-48 rounded-full border-4 border-indigo-500/20 flex items-center justify-center relative">
                  <div className="absolute inset-0 rounded-full border-2 border-indigo-400/50 pulse" />
                  <div className="w-32 h-32 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-500 flex items-center justify-center shadow-2xl">
                    <svg className="w-12 h-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
               </div>
               <p className="mt-8 text-xl font-medium text-white">Je vous écoute...</p>
               <p className="mt-2 text-slate-400 text-sm">Donovan est prêt à répondre à vos questions</p>
               
               <button
                  onClick={stopSession}
                  className="mt-12 px-6 py-2 border border-red-500/50 text-red-400 hover:bg-red-500 hover:text-white rounded-full transition-all text-sm font-medium"
                >
                  Terminer l'appel
                </button>
            </div>
          )}
        </div>

        {/* Transcript History */}
        {messages.length > 0 && (
          <div className="h-1/3 glass rounded-2xl p-4 overflow-y-auto space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] p-3 rounded-2xl text-sm ${
                  m.role === 'user' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-slate-800 text-slate-200'
                }`}>
                  <p className="font-bold text-[10px] uppercase opacity-50 mb-1">
                    {m.role === 'user' ? 'Vous' : 'Donovan'}
                  </p>
                  {m.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Quick Access Sidebar / Bottom Info */}
      <footer className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass p-3 rounded-xl text-center">
          <p className="text-[10px] text-slate-500 uppercase font-bold">Formation</p>
          <p className="text-xs font-medium truncate">MSc @ Inseec</p>
        </div>
        <div className="glass p-3 rounded-xl text-center">
          <p className="text-[10px] text-slate-500 uppercase font-bold">Poste Actuel</p>
          <p className="text-xs font-medium truncate">Alternant @ Paymium</p>
        </div>
        <div className="glass p-3 rounded-xl text-center">
          <p className="text-[10px] text-slate-500 uppercase font-bold">Spécialité</p>
          <p className="text-xs font-medium truncate">Web3 & IA</p>
        </div>
        <div className="glass p-3 rounded-xl text-center">
          <p className="text-[10px] text-slate-500 uppercase font-bold">Localisation</p>
          <p className="text-xs font-medium truncate">Région Parisienne</p>
        </div>
      </footer>
    </div>
  );
};

export default App;
