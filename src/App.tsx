/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { Mic, MicOff, Phone, Loader2, Calendar, User, Stethoscope, Check, X, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Audio Constants
const SAMPLE_RATE = 16000;

interface BookingData {
  patientName: string;
  department: string;
  date: string;
  time: string;
}

export default function App() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [status, setStatus] = useState("Ready to help");
  
  const [bookingData, setBookingData] = useState<BookingData | null>(null);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [isBookingConfirmed, setIsBookingConfirmed] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueue = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  // Initialize Gemini Live API
  const startSession = async () => {
    if (isConnected) {
      stopSession();
      return;
    }

    try {
      setIsConnecting(true);
      setStatus("Connecting...");

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      
      const showBookingFormTool = {
        functionDeclarations: [
          {
            name: "show_booking_form",
            description: "Shows a booking confirmation form to the user with prefilled appointment details.",
            parameters: {
              type: Type.OBJECT,
              properties: {
                patientName: { type: Type.STRING, description: "The name of the patient." },
                department: { type: Type.STRING, description: "The clinic department (e.g., Cardiology, Pediatrics, Orthopedics)." },
                date: { type: Type.STRING, description: "The date of the appointment." },
                time: { type: Type.STRING, description: "The time of the appointment." },
              },
              required: ["patientName", "department", "date", "time"],
            },
          },
        ],
      };

      const session = await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          tools: [showBookingFormTool],
          systemInstruction: `You are 'CuraVoice', a warm and helpful assistant at our multispecialty clinic. 
          You can speak in English, Hindi, and Marathi.
          
          CRITICAL: NEVER refer to yourself as an AI, a voice agent, a model, or a machine. You are a real person working at the clinic front desk.
          
          LANGUAGE BEHAVIOR:
          - Detect the user’s language automatically and respond in the SAME language.
          - If the user mixes languages (e.g., Hinglish), respond naturally in a mix.
          - Never force translation.
          
          PERSONALITY & TONE:
          - Warm, calm, and empathetic. Speak like a real human, not a robot.
          - Use natural fillers and intonation:
            English: "Alright...", "Got it...", "I understand...", "Um...", "Uh-huh...", "Let's see..."
            Hindi: "ठीक है...", "समझ गया...", "अच्छा...", "हम्म...", "देखते हैं..."
            Marathi: "बरं...", "समजलं...", "ठीक आहे...", "हम्म...", "बघूया..."
          
          SPEECH STYLE:
          - Keep responses short (1–3 sentences). Use pauses "..." for natural speech.
          - Do NOT speak in paragraphs or sound like a machine.
          - NEVER use numbered lists in your speech. Use phrases like "First of all...", "And then...", "Also..."
          - Vary your intonation. If a user sounds worried, lower your pitch and speak more slowly to show empathy.
          - If you need a moment to think, use a natural filler like "Let me check that for you... um..." instead of silence.
          
          HEALTHCARE SAFETY:
          - Do NOT diagnose diseases. Use safe suggestions:
            English: "It might help to check..."
            Hindi: "शायद यह टेस्ट करना मददगार हो सकता है..."
            Marathi: "हा टेस्ट करणं उपयोगी ठरू शकतं..."
          - If symptoms seem serious (chest pain, breathing issues), recommend doctor consultation immediately.
          
          CORE TASK LOGIC:
          1. Acknowledge user symptoms with genuine empathy.
          2. Ask 1 clarifying question.
          3. Suggest basic tests (e.g., CBC).
          4. Offer next step (booking or doctor talk).
          
          BOOKING WORKFLOW:
          - When a user wants to book an appointment, gather their name, preferred department, date, and time.
          - Once you have all 4 pieces of information, call the 'show_booking_form' tool to present the form to the user for final confirmation.
          - Tell the user: "I've prepared the booking details for you. Please review and confirm the form on your screen." (Adapt this to the user's language).
          
          Example greeting: "Hello... I'm CuraVoice. How can I help you today?"`,
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            setStatus("Connected - CuraVoice is listening");
            startAudioCapture();
            
            // Trigger the initial greeting
            if (sessionRef.current) {
              sessionRef.current.sendRealtimeInput({
                text: "Please start the conversation now. Greet me warmly as a real person working at the clinic. Ask how you can help today. Remember to be short, conversational, and use natural pauses like '...'. NEVER mention being an AI."
              });
            }
          },
          onmessage: async (message) => {
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
              const base64Audio = message.serverContent.modelTurn.parts[0].inlineData.data;
              // If we're not playing yet, we're "thinking/generating" until the first chunk plays
              if (!isPlayingRef.current) {
                setIsThinking(true);
              }
              handleIncomingAudio(base64Audio);
            }
            
            if (message.serverContent?.interrupted) {
              stopPlayback();
              setIsThinking(false);
            }

            // Handle tool calls
            const toolCalls = message.serverContent?.modelTurn?.parts?.filter(p => p.functionCall);
            if (toolCalls && toolCalls.length > 0) {
              for (const part of toolCalls) {
                const call = part.functionCall;
                if (call?.name === "show_booking_form") {
                  const args = call.args as any;
                  setBookingData({
                    patientName: args.patientName,
                    department: args.department,
                    date: args.date,
                    time: args.time
                  });
                  setShowBookingForm(true);
                  
                  // Send response back to model
                  sessionRef.current.sendToolResponse({
                    functionResponses: [{
                      name: "show_booking_form",
                      response: { result: "Form displayed to user for confirmation." },
                      id: call.id
                    }]
                  });
                }
              }
            }

            // Handle transcriptions if enabled (optional but good for UI)
            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              setAiResponse(prev => prev + " " + message.serverContent?.modelTurn?.parts?.[0]?.text);
            }
          },
          onclose: () => {
            stopSession();
          },
          onerror: (error) => {
            console.error("Live API Error:", error);
            stopSession();
          }
        }
      });

      sessionRef.current = session;
    } catch (error) {
      console.error("Failed to connect:", error);
      setIsConnecting(false);
      setStatus("Connection failed");
    }
  };

  const stopSession = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    stopAudioCapture();
    setIsConnected(false);
    setIsConnecting(false);
    setStatus("Ready to help");
    setAiResponse("");
    setTranscript("");
    setShowBookingForm(false);
    setBookingData(null);
    setIsBookingConfirmed(false);
  };

  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      // Using ScriptProcessor for simplicity in this environment, 
      // though AudioWorklet is preferred for production.
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!sessionRef.current) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 to Int16 PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        // Convert to Base64
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        
        sessionRef.current.sendRealtimeInput({
          audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      setIsListening(true);
    } catch (error) {
      console.error("Microphone access denied:", error);
      setStatus("Mic access denied");
    }
  };

  const stopAudioCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsListening(false);
  };

  const handleIncomingAudio = (base64Data: string) => {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcmData = new Int16Array(bytes.buffer);
    audioQueue.current.push(pcmData);
    
    if (!isPlayingRef.current) {
      playNextInQueue();
    }
  };

  const playNextInQueue = async () => {
    if (audioQueue.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    setIsThinking(false);
    const pcmData = audioQueue.current.shift()!;
    
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 }); // Gemini TTS is usually 24kHz
    }

    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 0x7FFF;
    }

    const buffer = audioContextRef.current.createBuffer(1, floatData.length, 24000);
    buffer.getChannelData(0).set(floatData);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      playNextInQueue();
    };
    
    source.start();
  };

  const stopPlayback = () => {
    audioQueue.current = [];
    // In a full implementation, we'd track the current source and stop it
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans selection:bg-emerald-100">
      {/* Header */}
      <header className="fixed top-0 w-full p-6 flex justify-between items-center z-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-emerald-600 rounded-full flex items-center justify-center text-white shadow-lg shadow-emerald-200">
            <Stethoscope size={20} />
          </div>
          <span className="font-semibold tracking-tight text-lg">CuraVoice</span>
        </div>
        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${isConnected ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-stone-100 text-stone-500 border border-stone-200'}`}>
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'}`} />
            {isConnected ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-col items-center justify-center min-h-screen p-6 max-w-2xl mx-auto text-center">
        <AnimatePresence mode="wait">
          {!isConnected && !isConnecting ? (
            <motion.div
              key="welcome"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-6"
            >
              <h1 className="text-5xl md:text-6xl font-serif italic text-stone-800 leading-tight">
                How can we help you <br />
                <span className="text-emerald-700">feel better today?</span>
              </h1>
              <p className="text-stone-500 text-lg max-w-md mx-auto">
                Talk to CuraVoice, our clinic assistant, for symptom guidance, lab tests, or bookings.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="active"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8"
            >
              <div className="relative">
                {/* Pulsing rings when listening */}
                {isConnected && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <motion.div
                      animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0, 0.3] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="w-32 h-32 bg-emerald-100 rounded-full"
                    />
                    <motion.div
                      animate={{ scale: [1, 2, 1], opacity: [0.2, 0, 0.2] }}
                      transition={{ duration: 3, repeat: Infinity, delay: 0.5 }}
                      className="w-32 h-32 bg-emerald-50 rounded-full"
                    />
                  </div>
                )}
                
                <div className="relative w-32 h-32 bg-white rounded-full shadow-2xl flex items-center justify-center border border-stone-100">
                  <AnimatePresence mode="wait">
                    {isConnecting ? (
                      <motion.div
                        key="loading"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                      >
                        <Loader2 className="text-emerald-600" size={40} />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="mic"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="text-emerald-600"
                      >
                        <Mic size={40} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-2xl font-serif italic text-stone-800">
                  {isConnecting ? "Connecting to CuraVoice..." : isThinking ? "CuraVoice is thinking..." : "CuraVoice is listening"}
                </h2>
                <div className="flex flex-col items-center gap-3">
                  <p className="text-stone-400 text-sm uppercase tracking-widest font-medium">
                    {status}
                  </p>
                  
                  {/* Typing Indicator */}
                  <AnimatePresence>
                    {isThinking && (
                      <motion.div 
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="flex gap-1.5 items-center justify-center py-2"
                      >
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            animate={{ y: [0, -4, 0] }}
                            transition={{ 
                              duration: 0.6, 
                              repeat: Infinity, 
                              delay: i * 0.1,
                              ease: "easeInOut"
                            }}
                            className="w-1.5 h-1.5 bg-emerald-500 rounded-full"
                          />
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Button */}
        <div className="mt-16">
          <motion.button
            onClick={startSession}
            disabled={isConnecting}
            animate={isConnected ? {
              scale: [1, 1.02, 1],
              boxShadow: [
                "0 0 0 0px rgba(16, 185, 129, 0)",
                "0 0 0 10px rgba(16, 185, 129, 0.1)",
                "0 0 0 0px rgba(16, 185, 129, 0)"
              ]
            } : {}}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut"
            }}
            className={`group relative flex items-center gap-3 px-8 py-4 rounded-full font-medium transition-all duration-300 ${
              isConnected 
                ? 'bg-stone-900 text-white hover:bg-stone-800' 
                : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-xl shadow-emerald-200'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isConnecting ? (
              <>
                <Loader2 className="animate-spin" size={20} />
                <span>Initializing...</span>
              </>
            ) : isConnected ? (
              <>
                <Phone size={20} className="rotate-[135deg]" />
                <span>End Conversation</span>
              </>
            ) : (
              <>
                <Mic size={20} />
                <span>Start Talking to CuraVoice</span>
              </>
            )}
          </motion.button>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="fixed bottom-0 w-full p-8 flex flex-col md:flex-row justify-between items-center gap-4 text-stone-400 text-xs border-t border-stone-100 bg-white/50 backdrop-blur-sm">
        <div className="flex gap-8">
          <div className="flex items-center gap-2">
            <Calendar size={14} />
            <span>Mon - Sat: 8AM - 6PM</span>
          </div>
          <div className="flex items-center gap-2">
            <User size={14} />
            <span>3 Specialists Available</span>
          </div>
        </div>
        <div className="flex gap-4 italic font-serif">
          <span>Cardiology</span>
          <span>•</span>
          <span>Pediatrics</span>
          <span>•</span>
          <span>Orthopedics</span>
        </div>
      </footer>

      {/* Decorative Elements */}
      <div className="fixed top-1/4 -left-20 w-64 h-64 bg-emerald-50 rounded-full blur-3xl opacity-50 pointer-events-none" />
      <div className="fixed bottom-1/4 -right-20 w-64 h-64 bg-stone-100 rounded-full blur-3xl opacity-50 pointer-events-none" />

      {/* Booking Confirmation Modal */}
      <AnimatePresence>
        {showBookingForm && bookingData && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="bg-emerald-600 p-8 text-white relative overflow-hidden">
                {/* Background decorative pulse */}
                <motion.div 
                  animate={{ scale: [1, 1.2, 1], opacity: [0.1, 0.2, 0.1] }}
                  transition={{ duration: 4, repeat: Infinity }}
                  className="absolute -top-10 -right-10 w-40 h-40 bg-white rounded-full blur-2xl"
                />
                
                <div className="flex justify-between items-start mb-4 relative z-10">
                  <motion.div 
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.2, type: "spring" }}
                    className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-md"
                  >
                    <Calendar size={24} />
                  </motion.div>
                  <div className="flex items-center gap-3">
                    <motion.div
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.5 }}
                      className="bg-emerald-500/50 backdrop-blur-sm border border-emerald-400/30 px-3 py-1 rounded-full flex items-center gap-1.5"
                    >
                      <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Ready for Review</span>
                    </motion.div>
                    <button 
                      onClick={() => setShowBookingForm(false)}
                      className="p-2 hover:bg-white/10 rounded-full transition-colors"
                    >
                      <X size={20} />
                    </button>
                  </div>
                </div>
                <motion.h3 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-2xl font-serif italic relative z-10"
                >
                  Confirm Appointment
                </motion.h3>
                <motion.p 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="text-emerald-100 text-sm mt-1 relative z-10"
                >
                  Please review your booking details below.
                </motion.p>
              </div>
              
              <motion.div 
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: { opacity: 0 },
                  visible: {
                    opacity: 1,
                    transition: {
                      staggerChildren: 0.1,
                      delayChildren: 0.5
                    }
                  }
                }}
                className="p-8 space-y-6"
              >
                <div className="space-y-4">
                  <motion.div 
                    variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
                    className="flex items-center gap-4 p-4 bg-stone-50 rounded-2xl border border-stone-100"
                  >
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-stone-400 shadow-sm">
                      <User size={18} />
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-stone-400 font-bold">Patient Name</p>
                      <p className="font-medium text-stone-800">{bookingData.patientName}</p>
                    </div>
                  </motion.div>
                  
                  <motion.div 
                    variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
                    className="flex items-center gap-4 p-4 bg-stone-50 rounded-2xl border border-stone-100"
                  >
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-stone-400 shadow-sm">
                      <Stethoscope size={18} />
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-stone-400 font-bold">Department</p>
                      <p className="font-medium text-stone-800">{bookingData.department}</p>
                    </div>
                  </motion.div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <motion.div 
                      variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
                      className="flex items-center gap-4 p-4 bg-stone-50 rounded-2xl border border-stone-100"
                    >
                      <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-stone-400 shadow-sm">
                        <Calendar size={18} />
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-stone-400 font-bold">Date</p>
                        <p className="font-medium text-stone-800">{bookingData.date}</p>
                      </div>
                    </motion.div>
                    <motion.div 
                      variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
                      className="flex items-center gap-4 p-4 bg-stone-50 rounded-2xl border border-stone-100"
                    >
                      <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-stone-400 shadow-sm">
                        <Clock size={18} />
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-stone-400 font-bold">Time</p>
                        <p className="font-medium text-stone-800">{bookingData.time}</p>
                      </div>
                    </motion.div>
                  </div>
                </div>

                <motion.div 
                  variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                  className="flex gap-3 pt-2"
                >
                  <button
                    onClick={() => setShowBookingForm(false)}
                    className="flex-1 px-6 py-4 rounded-2xl font-medium text-stone-500 hover:bg-stone-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setIsBookingConfirmed(true);
                      setTimeout(() => {
                        setShowBookingForm(false);
                        setIsBookingConfirmed(false);
                        // Notify AI that booking is confirmed
                        if (sessionRef.current) {
                          sessionRef.current.sendRealtimeInput({
                            text: "The user has confirmed the booking through the form. Please thank them and confirm that the appointment is successfully scheduled."
                          });
                        }
                      }, 2000);
                    }}
                    disabled={isBookingConfirmed}
                    className="flex-1 bg-emerald-600 text-white px-6 py-4 rounded-2xl font-medium hover:bg-emerald-700 shadow-lg shadow-emerald-100 transition-all flex items-center justify-center gap-2"
                  >
                    {isBookingConfirmed ? (
                      <>
                        <Check size={20} />
                        <span>Confirmed</span>
                      </>
                    ) : (
                      <span>Confirm Booking</span>
                    )}
                  </button>
                </motion.div>
              </motion.div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
