/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, History, X, Check, Zap, ZapOff, RotateCcw, Image as ImageIcon, Scan, ChevronLeft, LogOut, Send, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Receipt, Point, Quad } from './types';

interface GoogleUser {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}

export default function App() {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<'scanner' | 'gallery' | 'detail'>('scanner');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [isAutoCapture, setIsAutoCapture] = useState(true);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const [isDemoMode, setIsDemoMode] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Auth State
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/me');
        const data = await response.json();
        setUser(data.user);
      } catch (error) {
        console.error("Auth check failed:", error);
      } finally {
        setAuthReady(true);
      }
    };

    checkAuth();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        checkAuth();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Sync Receipts from API
  useEffect(() => {
    if (!user) {
      setReceipts([]);
      return;
    }

    const fetchReceipts = async () => {
      try {
        const response = await fetch('/api/receipts');
        if (response.ok) {
          const data = await response.json();
          setReceipts(data.sort((a: Receipt, b: Receipt) => b.timestamp - a.timestamp));
        }
      } catch (error) {
        console.error("Fetch receipts error:", error);
      }
    };

    fetchReceipts();
  }, [user, view]); // Re-fetch when view changes back to gallery

  // Initialize Camera
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setCameraError("Camera access denied or not available. Please check your permissions.");
    }
  }, []);

  useEffect(() => {
    if (view === 'scanner' && !capturedImage && (user || isDemoMode)) {
      startCamera();
    }
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [view, capturedImage, startCamera, user, isDemoMode]);

  // Edge Detection Simulation & Auto-Capture Logic
  useEffect(() => {
    if (view !== 'scanner' || capturedImage || !isAutoCapture || (!user && !isDemoMode)) return;

    let animationFrameId: number;
    let detectionCounter = 0;
    let focusCounter = 0;
    const DETECTION_THRESHOLD = 45; 
    const FOCUS_THRESHOLD = 15; 

    const processFrame = () => {
      if (!videoRef.current || !overlayCanvasRef.current) return;

      const video = videoRef.current;
      const canvas = overlayCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
        canvas.width = video.clientWidth;
        canvas.height = video.clientHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const margin = canvas.width * 0.15;
      const w = canvas.width - margin * 2;
      const h = w * 1.4; 
      const y = (canvas.height - h) / 2;

      const jitter = Math.sin(Date.now() / 200) * 2;
      const currentJitter = Math.abs(jitter);
      
      if (currentJitter < 1.5) {
        focusCounter++;
      } else {
        focusCounter = 0;
      }
      
      const focused = focusCounter > FOCUS_THRESHOLD;
      setIsFocused(focused);

      ctx.strokeStyle = focused ? '#34c759' : '#0a84ff'; 
      ctx.lineWidth = 3;
      ctx.setLineDash(focused ? [] : [20, 10]); 
      
      const corners = [
        { x: margin + jitter, y: y + jitter },
        { x: margin + w - jitter, y: y - jitter },
        { x: margin + w + jitter, y: y + h + jitter },
        { x: margin - jitter, y: y + h - jitter }
      ];

      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      ctx.lineTo(corners[1].x, corners[1].y);
      ctx.lineTo(corners[2].x, corners[2].y);
      ctx.lineTo(corners[3].x, corners[3].y);
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = focused ? 'rgba(52, 199, 89, 0.1)' : 'rgba(10, 132, 255, 0.1)';
      ctx.fill();

      if (focused) {
        detectionCounter++;
        if (detectionCounter > DETECTION_THRESHOLD) {
          handleCapture();
          detectionCounter = 0;
        }
      } else {
        detectionCounter = 0;
      }

      animationFrameId = requestAnimationFrame(processFrame);
    };

    animationFrameId = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(animationFrameId);
  }, [view, capturedImage, isAutoCapture, user, isDemoMode]);

  const handleCapture = () => {
    if (isCapturing || capturedImage || isProcessing) return;
    
    setIsCapturing(true);
    
    const flash = document.createElement('div');
    flash.className = 'fixed inset-0 bg-white z-[100] opacity-0 transition-opacity duration-100';
    document.body.appendChild(flash);
    setTimeout(() => flash.style.opacity = '1', 10);
    setTimeout(() => {
      flash.style.opacity = '0';
      setTimeout(() => document.body.removeChild(flash), 100);
    }, 150);

    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        
        setIsProcessing(true);
        
        setTimeout(() => {
          setCapturedImage(dataUrl);
          setIsProcessing(false);
          setIsCapturing(false);
          
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
          }
        }, 1200);
      }
    }
  };

  const saveReceipt = async () => {
    if (!capturedImage || !user) return;
    
    const newReceipt = {
      image: capturedImage,
      name: `Receipt ${new Date().toLocaleDateString()}`
    };
    
    try {
      const response = await fetch('/api/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newReceipt)
      });
      
      if (response.ok) {
        setCapturedImage(null);
        setView('gallery');
      }
    } catch (error) {
      console.error("Error saving receipt:", error);
    }
  };

  const deleteReceipt = async (id: string) => {
    try {
      const response = await fetch(`/api/receipts/${id}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        setReceipts(prev => prev.filter(r => r.id !== id));
        if (selectedReceipt?.id === id) {
          setSelectedReceipt(null);
          setView('gallery');
        }
      }
    } catch (error) {
      console.error("Error deleting receipt:", error);
    }
  };

  const sendToWebhook = async (receipt: Receipt) => {
    if (!user || isSending) return;
    
    setIsSending(true);
    
    const payload = {
      email: user.email,
      username: user.name,
      image: receipt.image,
      timestamp: receipt.timestamp,
      receiptId: receipt.id
    };

    console.log("Sending to webhook:", payload);

    try {
      const response = await fetch('https://n8n.robosouthla.com/webhook/scanner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        alert("Receipt sent successfully!");
      } else {
        throw new Error("Webhook failed");
      }
    } catch (error) {
      console.error("Webhook Error:", error);
      alert("Failed to send receipt.");
    } finally {
      setIsSending(false);
    }
  };

  const downloadImage = (dataUrl: string, name: string) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${name.replace(/\s+/g, '_')}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleLogin = async () => {
    try {
      const redirectUri = `${window.location.origin}/auth/callback`;
      const response = await fetch(`/api/auth/url?redirectUri=${encodeURIComponent(redirectUri)}`);
      const { url } = await response.json();
      window.open(url, 'google_oauth', 'width=600,height=700');
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setView('scanner');
    } catch (error) {
      console.error("Logout Error:", error);
    }
  };

  if (!authReady) {
    return (
      <div className="h-[100dvh] bg-black flex flex-col items-center justify-center gap-4">
        <Loader2 className="animate-spin text-blue-500" size={48} />
        <p className="text-ios-gray animate-pulse">Initializing Scanner...</p>
      </div>
    );
  }

  if (!user && !isDemoMode) {
    return (
      <div className="h-[100dvh] bg-black flex flex-col items-center justify-center p-8 text-center overflow-y-auto">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="w-24 h-24 bg-blue-500 rounded-3xl flex items-center justify-center mb-8 shadow-[0_0_40px_rgba(59,130,246,0.5)]"
        >
          <Scan size={48} className="text-white" />
        </motion.div>
        <motion.h1 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="text-4xl font-bold mb-4 tracking-tight"
        >
          RoboSouth LA Receipt Scanner
        </motion.h1>
        <motion.p 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-ios-gray mb-12 max-w-xs text-lg"
        >
          Smart edge detection and automatic capture for your invoices and receipts.
        </motion.p>
        
        <div className="w-full max-w-xs flex flex-col gap-4">
          <motion.button 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3 }}
            onClick={handleLogin}
            className="w-full py-4 bg-white text-black rounded-2xl font-bold flex items-center justify-center gap-3 ios-btn-active shadow-xl border border-white/20"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Sign in with Google
          </motion.button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-black text-white overflow-hidden safe-area-inset">
      
      {/* Main Viewport */}
      <div className="relative flex-1 overflow-hidden">
        
        {/* Scanner View */}
        {view === 'scanner' && (
          <div className="absolute inset-0 flex flex-col">
            {!capturedImage ? (
              <>
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <canvas 
                  ref={overlayCanvasRef} 
                  className="absolute inset-0 w-full h-full pointer-events-none z-10"
                />
                
                {cameraError && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-8 text-center bg-black/80">
                    <div className="p-4 rounded-full bg-red-500/20 text-red-500 mb-4">
                      <Camera size={48} />
                    </div>
                    <h3 className="text-xl font-bold mb-2">Camera Error</h3>
                    <p className="text-ios-gray mb-6">{cameraError}</p>
                    <button 
                      onClick={startCamera}
                      className="px-6 py-3 bg-blue-500 rounded-xl font-bold ios-btn-active"
                    >
                      Try Again
                    </button>
                  </div>
                )}

                {/* Scanner UI Overlays */}
                <div className="absolute top-0 left-0 right-0 p-6 pt-16 flex justify-between items-center z-30 bg-gradient-to-b from-black/80 to-transparent">
                  <button 
                    onClick={() => setView('gallery')}
                    className="p-4 rounded-full bg-white/20 backdrop-blur-xl border border-white/20 ios-btn-active shadow-2xl text-white"
                  >
                    <History size={28} />
                  </button>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setIsFlashOn(!isFlashOn)}
                      className={`p-4 rounded-full backdrop-blur-xl border border-white/20 ios-btn-active shadow-2xl ${isFlashOn ? 'bg-yellow-400 text-black' : 'bg-white/20 text-white'}`}
                    >
                      {isFlashOn ? <Zap size={28} /> : <ZapOff size={28} />}
                    </button>
                    <button 
                      onClick={() => setIsAutoCapture(!isAutoCapture)}
                      className={`px-6 py-3 rounded-full text-sm font-bold backdrop-blur-xl border border-white/20 ios-btn-active shadow-2xl ${isAutoCapture ? 'bg-blue-500 text-white' : 'bg-white/20 text-white'}`}
                    >
                      {isAutoCapture ? 'AUTO' : 'MANUAL'}
                    </button>
                  </div>
                </div>

                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className={`w-64 h-96 border-2 rounded-2xl relative overflow-hidden transition-colors duration-300 ${isFocused ? 'border-green-500' : 'border-white/30'}`}>
                    <div className={`absolute inset-0 animate-scan ${isFocused ? 'bg-green-500/10' : 'bg-blue-500/10'}`} />
                    {!isFocused && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-[10px] font-bold tracking-widest uppercase opacity-50">Focusing...</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="absolute bottom-0 left-0 right-0 p-12 pb-24 flex justify-center items-center z-30 bg-gradient-to-t from-black/80 to-transparent">
                  <button 
                    onClick={handleCapture}
                    disabled={isCapturing || isProcessing || (!!cameraError && !isDemoMode)}
                    className="w-24 h-24 rounded-full border-4 border-white p-2 ios-btn-active relative shadow-[0_0_30px_rgba(255,255,255,0.3)] disabled:opacity-50"
                  >
                    <div className={`w-full h-full rounded-full transition-all duration-300 ${isFocused ? 'bg-green-500 scale-90 shadow-[0_0_25px_rgba(34,197,94,0.6)]' : 'bg-white'}`} />
                    {isProcessing && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-20 h-20 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </button>
                </div>

                {isProcessing && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center glass">
                    <div className="w-20 h-20 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-6" />
                    <h2 className="text-xl font-semibold">Processing Receipt...</h2>
                    <p className="text-ios-gray mt-2">Optimizing edges and text</p>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 bg-black flex flex-col">
                <div className="flex-1 relative p-4 flex flex-col">
                  <div className="text-center mb-4 mt-4">
                    <h2 className="text-xl font-bold">Is the quality good?</h2>
                    <p className="text-sm text-ios-gray mt-1 px-8">Ensure the receipt is clean and all text is clearly readable before saving.</p>
                  </div>
                  <div className="flex-1 relative">
                    <img src={capturedImage} className="w-full h-full object-contain rounded-2xl shadow-2xl" alt="Captured" />
                  </div>
                </div>
                <div className="p-10 pb-16 glass flex justify-around items-center z-40">
                  <button 
                    onClick={() => setCapturedImage(null)}
                    className="flex flex-col items-center gap-3 text-white ios-btn-active"
                  >
                    <div className="p-5 rounded-full bg-white/20 backdrop-blur-xl border border-white/10 shadow-xl">
                      <RotateCcw size={32} />
                    </div>
                    <span className="text-sm font-bold">Retake</span>
                  </button>
                  <button 
                    onClick={() => {
                      if (capturedImage) {
                        downloadImage(capturedImage, `Receipt_${Date.now()}`);
                      }
                    }}
                    className="flex flex-col items-center gap-3 text-white ios-btn-active"
                  >
                    <div className="p-5 rounded-full bg-white/20 backdrop-blur-xl border border-white/10 shadow-xl">
                      <ImageIcon size={32} />
                    </div>
                    <span className="text-sm font-bold">Save</span>
                  </button>
                  <button 
                    onClick={saveReceipt}
                    className="flex flex-col items-center gap-3 text-white ios-btn-active"
                  >
                    <div className="p-5 rounded-full bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]">
                      <Check size={32} />
                    </div>
                    <span className="text-sm font-bold">Keep</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Gallery View */}
        {view === 'gallery' && (
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            className="absolute inset-0 bg-black flex flex-col"
          >
            <div className="p-6 flex justify-between items-center glass sticky top-0 z-20">
              <div className="flex items-center gap-3">
                <img src={user.picture || ''} className="w-8 h-8 rounded-full border border-white/20" alt="User" />
                <h1 className="text-2xl font-bold">Scans</h1>
              </div>
              <div className="flex items-center gap-3">
                <button 
                  onClick={handleLogout}
                  className="p-2 rounded-full bg-white/10 text-ios-gray ios-btn-active"
                >
                  <LogOut size={20} />
                </button>
                <button 
                  onClick={() => setView('scanner')}
                  className="p-2 rounded-full bg-blue-500 text-white ios-btn-active"
                >
                  <Camera size={24} />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-4 pb-20">
              {receipts.length === 0 ? (
                <div className="col-span-2 flex flex-col items-center justify-center h-64 text-ios-gray">
                  <Scan size={48} strokeWidth={1} className="mb-4 opacity-20" />
                  <p>No receipts scanned yet</p>
                </div>
              ) : (
                receipts.map(receipt => (
                  <motion.div 
                    layoutId={receipt.id}
                    key={receipt.id}
                    onClick={() => {
                      setSelectedReceipt(receipt);
                      setView('detail');
                    }}
                    className="aspect-[3/4] bg-ios-surface rounded-xl overflow-hidden relative ios-btn-active"
                  >
                    <img src={receipt.image} className="w-full h-full object-cover" alt={receipt.name} />
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent">
                      <p className="text-[10px] font-medium truncate opacity-80">{new Date(receipt.timestamp).toLocaleDateString()}</p>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </motion.div>
        )}

        {/* Detail View */}
        {view === 'detail' && selectedReceipt && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 bg-black z-50 flex flex-col"
          >
            <div className="p-6 flex justify-between items-center glass">
              <button 
                onClick={() => setView('gallery')}
                className="flex items-center gap-1 text-blue-500 font-medium ios-btn-active"
              >
                <ChevronLeft size={24} />
                <span>Back</span>
              </button>
              <button 
                onClick={() => deleteReceipt(selectedReceipt.id)}
                className="text-red-500 font-medium ios-btn-active"
              >
                Delete
              </button>
            </div>
            <div className="flex-1 p-4 flex items-center justify-center">
              <img 
                src={selectedReceipt.image} 
                className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" 
                alt={selectedReceipt.name} 
              />
            </div>
            <div className="p-8 glass flex flex-col items-center">
              <h2 className="text-xl font-semibold mb-1">{selectedReceipt.name}</h2>
              <p className="text-ios-gray text-sm">{new Date(selectedReceipt.timestamp).toLocaleString()}</p>
              
              <div className="mt-8 flex flex-col gap-4 w-full">
                <div className="flex gap-4">
                  <button 
                    onClick={() => downloadImage(selectedReceipt.image, selectedReceipt.name)}
                    className="flex-1 py-4 rounded-2xl bg-white/10 font-semibold ios-btn-active flex items-center justify-center gap-2"
                  >
                    <ImageIcon size={20} />
                    Save to Photos
                  </button>
                  <button 
                    onClick={() => sendToWebhook(selectedReceipt)}
                    disabled={isSending}
                    className="flex-1 py-4 rounded-2xl bg-blue-500 font-semibold ios-btn-active flex items-center justify-center gap-2"
                  >
                    {isSending ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                    {isSending ? 'Sending...' : 'Send to Webhook'}
                  </button>
                </div>
                <button className="w-full py-4 rounded-2xl bg-white/5 text-ios-gray font-semibold ios-btn-active">
                  Share
                </button>
              </div>
            </div>
          </motion.div>
        )}

      </div>

      {/* Hidden Canvas for Processing */}
      <canvas ref={canvasRef} className="hidden" />
      
      {/* Tab Bar (only in gallery) */}
      {view === 'gallery' && (
        <div className="h-20 glass border-t border-white/5 flex justify-around items-center px-6 pb-4">
          <button className="flex flex-col items-center gap-1 text-blue-500">
            <History size={24} />
            <span className="text-[10px] font-medium">Recent</span>
          </button>
          <button 
            onClick={() => setView('scanner')}
            className="flex flex-col items-center gap-1 text-ios-gray"
          >
            <Camera size={24} />
            <span className="text-[10px] font-medium">Scan</span>
          </button>
          <button className="flex flex-col items-center gap-1 text-ios-gray">
            <ImageIcon size={24} />
            <span className="text-[10px] font-medium">Library</span>
          </button>
        </div>
      )}
    </div>
  );
}
