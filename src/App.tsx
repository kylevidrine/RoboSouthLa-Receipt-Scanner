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

const TOKEN_KEY = 'receipt_jwt';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function authFetch(input: string, init: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
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

  const [cvReady, setCvReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Off-screen canvas used for OpenCV processing (scaled down for perf)
  const procCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Wait for OpenCV.js WASM to finish initializing
  useEffect(() => {
    if (!procCanvasRef.current) {
      procCanvasRef.current = document.createElement('canvas');
    }
    const check = () => {
      const cv = (window as any).cv;
      if (cv && typeof cv.Mat === 'function') {
        setCvReady(true);
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  }, []);

  // Auth State
  useEffect(() => {
    // Pick up JWT from redirect URL (?token=...) and save it
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.setItem(TOKEN_KEY, urlToken);
      window.history.replaceState({}, '', '/');
    }

    const checkAuth = async () => {
      try {
        const response = await authFetch('/api/auth/me');
        const data = await response.json();
        setUser(data.user);
      } catch (error) {
        console.error("Auth check failed:", error);
      } finally {
        setAuthReady(true);
      }
    };

    checkAuth();
  }, []);

  // Sync Receipts from API
  useEffect(() => {
    if (!user) {
      setReceipts([]);
      return;
    }

    const fetchReceipts = async () => {
      try {
        const response = await authFetch('/api/receipts');
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

  // Real OpenCV edge detection & auto-capture
  useEffect(() => {
    if (view !== 'scanner' || capturedImage || !isAutoCapture || (!user && !isDemoMode) || !cvReady) return;

    const cv = (window as any).cv;
    const procCanvas = procCanvasRef.current;
    if (!cv || !procCanvas) return;

    let animationFrameId: number;
    let stableFrameCount = 0;
    let lastCorners: Point[] | null = null;
    let captureCalled = false;

    const STABLE_FRAMES = 20;
    const STABILITY_PX = 20; // max per-corner drift to count as stable

    const drawGuide = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const m = w * 0.08;
      const gw = w - m * 2;
      const gh = gw * 1.4;
      const gy = (h - gh) / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 2;
      ctx.setLineDash([20, 10]);
      ctx.strokeRect(m, gy, gw, gh);
      ctx.setLineDash([]);
    };

    const processFrame = () => {
      const video = videoRef.current;
      const overlay = overlayCanvasRef.current;

      if (!video || !overlay || video.readyState < 2 || video.videoWidth === 0) {
        animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      // Keep overlay matched to rendered video size
      if (overlay.width !== video.clientWidth || overlay.height !== video.clientHeight) {
        overlay.width = video.clientWidth;
        overlay.height = video.clientHeight;
      }

      // Scale video down for fast processing (~640px wide)
      const PROC_W = 640;
      const scale = PROC_W / video.videoWidth;
      procCanvas.width = PROC_W;
      procCanvas.height = Math.round(video.videoHeight * scale);

      const pCtx = procCanvas.getContext('2d', { willReadFrequently: true });
      if (!pCtx) { animationFrameId = requestAnimationFrame(processFrame); return; }
      pCtx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);

      const ctx = overlay.getContext('2d');
      if (!ctx) { animationFrameId = requestAnimationFrame(processFrame); return; }

      let src: any, gray: any, blurred: any, edges: any,
          contours: any, hierarchy: any, kernel: any;
      try {
        src       = cv.imread(procCanvas);
        gray      = new cv.Mat();
        blurred   = new cv.Mat();
        edges     = new cv.Mat();
        contours  = new cv.MatVector();
        hierarchy = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
        cv.Canny(blurred, edges, 50, 150);

        // Dilate slightly to close edge gaps
        kernel = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.dilate(edges, edges, kernel);

        cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        const minArea = procCanvas.width * procCanvas.height * 0.15;
        const scaleX  = overlay.width  / procCanvas.width;
        const scaleY  = overlay.height / procCanvas.height;

        let bestCorners: Point[] | null = null;
        let bestArea = 0;

        for (let i = 0; i < contours.size(); i++) {
          const cnt  = contours.get(i);
          const area = cv.contourArea(cnt);

          if (area > minArea && area > bestArea) {
            const peri = cv.arcLength(cnt, true);
            // Try progressively looser epsilon until we get a quad
            for (const eps of [0.02, 0.03, 0.05]) {
              const approx = new cv.Mat();
              cv.approxPolyDP(cnt, approx, eps * peri, true);
              if (approx.rows === 4) {
                const corners: Point[] = [];
                for (let j = 0; j < 4; j++) {
                  corners.push({
                    x: approx.data32S[j * 2]     * scaleX,
                    y: approx.data32S[j * 2 + 1] * scaleY,
                  });
                }
                bestCorners = corners;
                bestArea    = area;
                approx.delete();
                break;
              }
              approx.delete();
            }
          }
          cnt.delete();
        }

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (bestCorners) {
          const isStable = lastCorners !== null && lastCorners.every((pt, i) => {
            const dx = pt.x - bestCorners![i].x;
            const dy = pt.y - bestCorners![i].y;
            return Math.sqrt(dx * dx + dy * dy) < STABILITY_PX;
          });

          stableFrameCount = isStable ? stableFrameCount + 1 : 0;
          lastCorners      = bestCorners;

          const stable = stableFrameCount >= STABLE_FRAMES;
          setIsFocused(stable);

          ctx.strokeStyle = stable ? '#34c759' : '#0a84ff';
          ctx.lineWidth   = 3;
          ctx.setLineDash(stable ? [] : [10, 5]);
          ctx.beginPath();
          ctx.moveTo(bestCorners[0].x, bestCorners[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(bestCorners[i].x, bestCorners[i].y);
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = stable ? 'rgba(52,199,89,0.15)' : 'rgba(10,132,255,0.15)';
          ctx.fill();
          ctx.setLineDash([]);

          if (stable && !captureCalled) {
            captureCalled = true;
            handleCapture();
          }
        } else {
          stableFrameCount = 0;
          lastCorners      = null;
          setIsFocused(false);
          drawGuide(ctx, overlay.width, overlay.height);
        }
      } catch (err) {
        console.error('OpenCV frame error:', err);
      } finally {
        src?.delete();
        gray?.delete();
        blurred?.delete();
        edges?.delete();
        contours?.delete();
        hierarchy?.delete();
        kernel?.delete();
      }

      animationFrameId = requestAnimationFrame(processFrame);
    };

    animationFrameId = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(animationFrameId);
  }, [view, capturedImage, isAutoCapture, user, isDemoMode, cvReady]);

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

    const name = `Receipt ${new Date().toLocaleDateString()}`;
    downloadImage(capturedImage, name);

    const newReceipt = { image: capturedImage, name };

    try {
      const response = await authFetch('/api/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newReceipt)
      });

      if (response.ok) {
        const saved: Receipt = await response.json();
        setCapturedImage(null);
        setView('gallery');

        // Fire-and-forget webhook — don't block the UI
        fetch('https://n8n.robosouthla.com/webhook/scanner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: user.email,
            username: user.name,
            image: saved.image,
            timestamp: saved.timestamp,
            receiptId: saved.id,
          }),
        }).catch(err => console.error('Webhook error:', err));
      }
    } catch (error) {
      console.error("Error saving receipt:", error);
    }
  };

  const deleteReceipt = async (id: string) => {
    try {
      const response = await authFetch(`/api/receipts/${id}`, {
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
      const response = await fetch('/api/auth/url');
      const { url } = await response.json();
      window.location.href = url;
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  const handleLogout = async () => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setView('scanner');
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
          <div className="absolute inset-0 flex flex-col min-h-0">
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

                {!isFocused && cvReady && (
                  <div className="absolute bottom-32 left-0 right-0 flex justify-center pointer-events-none z-20">
                    <span className="text-[11px] font-bold tracking-widest uppercase text-white/50 bg-black/40 px-4 py-2 rounded-full">
                      Point at a document
                    </span>
                  </div>
                )}

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
              <div className="flex flex-col w-full h-full bg-black">
                <div className="flex-1 min-h-0 p-4 flex flex-col">
                  <div className="text-center mb-4 mt-4">
                    <h2 className="text-xl font-bold">Is the quality good?</h2>
                    <p className="text-sm text-ios-gray mt-1 px-8">Ensure the receipt is clean and all text is clearly readable before saving.</p>
                  </div>
                  <div className="flex-1 min-h-0">
                    <img src={capturedImage} className="w-full h-full object-contain rounded-2xl shadow-2xl" alt="Captured" />
                  </div>
                </div>
                <div className="flex-shrink-0 px-10 py-6 glass flex justify-around items-center">
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
