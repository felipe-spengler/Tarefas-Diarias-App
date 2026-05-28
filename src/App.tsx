import React, { useState, useEffect, useCallback } from 'react';
import { 
  Plus, 
  Calendar, 
  Clock, 
  Trash2, 
  Edit2, 
  Bell, 
  BellOff, 
  CheckCircle2, 
  AlertCircle,
  X,
  RotateCcw,
  Settings,
  History,
  Download,
  Share2,
  Copy,
  Check,
  Info,
  Sliders,
  Sparkles,
  MoreVertical
} from 'lucide-react';
import { format, addMinutes, isSameDay, parseISO, isValid, isBefore } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function generateId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (e) {}
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// Converte UUID de tarefa para ID numérico estável (LocalNotifications exige number)
function taskToNotifId(taskId: string): number {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = ((hash << 5) - hash) + taskId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2000000000; // Max safe Android notification ID
}

// --- Types ---
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 is Sunday

interface Task {
  id: string;
  type: 'routine' | 'event';
  title: string;
  time: string; // HH:mm
  date?: string; // YYYY-MM-DD
  weekdays?: DayOfWeek[];
  advanceMinutes: number;
  isActive: boolean;
  category: 'work' | 'health' | 'study' | 'personal' | 'other';
  lastNotifiedAt?: string;
  snoozedUntil?: string; // ISO string
  dependencyId?: string; // Conditional task
}

interface HistoryItem {
  id: string;
  taskId: string;
  title: string;
  completedAt: string;
  category: string;
  status: 'completed' | 'declined';
}

const CATEGORIES = {
  work: { label: 'Trabalho', color: 'bg-blue-500', text: 'text-blue-400' },
  health: { label: 'Saúde', color: 'bg-green-500', text: 'text-green-400' },
  study: { label: 'Estudo', color: 'bg-purple-500', text: 'text-purple-400' },
  personal: { label: 'Pessoal', color: 'bg-orange-500', text: 'text-orange-400' },
  other: { label: 'Outros', color: 'bg-zinc-500', text: 'text-zinc-400' },
};

const ALARM_SOUNDS = [
  { name: 'Beep Beep (Digital Clássico)', url: 'https://assets.mixkit.co/active_storage/sfx/941/941-preview.mp3' },
  { name: 'Sinos Chime (Suave e Agradável)', url: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3' },
  { name: 'Alerta Retrô (Eletrônico)', url: 'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3' },
  { name: 'Melodia Chime (Moderno)', url: 'https://assets.mixkit.co/active_storage/sfx/1353/1353-preview.mp3' }
];

const DAYS = [
  { label: 'D', value: 0 },
  { label: 'S', value: 1 },
  { label: 'T', value: 2 },
  { label: 'Q', value: 3 },
  { label: 'Q', value: 4 },
  { label: 'S', value: 5 },
  { label: 'S', value: 6 },
];

// Parseia uma string YYYY-MM-DD como horário LOCAL (evita bug de UTC-3 do parseISO)
function parseLocalDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

function getNextOccurrence(task: Task, now: Date): Date {
  const [hours, minutes] = task.time.split(':').map(Number);
  
  if (task.type === 'event') {
    if (task.date) {
      try {
        // Usa parseLocalDate para evitar bug de timezone (parseISO trata YYYY-MM-DD como UTC)
        const d = parseLocalDate(task.date);
        d.setHours(hours, minutes, 0, 0);
        if (isValid(d)) return d;
      } catch (e) {}
    }
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d;
  } else {
    const weekdays = task.weekdays && task.weekdays.length > 0 ? task.weekdays : [0, 1, 2, 3, 4, 5, 6] as DayOfWeek[];
    let minDiff = Infinity;
    let bestDate = new Date(now);
    
    for (let i = 0; i < 8; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      d.setHours(hours, minutes, 0, 0);
      
      const dayOfWeek = d.getDay() as DayOfWeek;
      if (weekdays.includes(dayOfWeek)) {
        // Se for hoje mas o horário do alarme (com antecedência) já passou, pula para o próximo dia
        const triggerTime = addMinutes(d, -task.advanceMinutes);
        if (i === 0 && triggerTime.getTime() <= now.getTime()) {
          continue;
        }
        
        const diff = d.getTime() - now.getTime();
        if (diff < minDiff) {
          minDiff = diff;
          bestDate = d;
        }
      }
    }
    return bestDate;
  }
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const sortedTasks = React.useMemo(() => {
    const now = new Date();
    return [...tasks].sort((a, b) => {
      const nextA = getNextOccurrence(a, now).getTime();
      const nextB = getNextOccurrence(b, now).getTime();
      return nextA - nextB;
    });
  }, [tasks]);
  const [isAdding, setIsAdding] = useState(false);
  const [activeTab, setActiveTab] = useState<'routine' | 'event'>('routine');
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // Global Navigation & Feedback States
  const [currentTab, setCurrentTab] = useState<'tasks' | 'timeline' | 'conditions' | 'history' | 'install'>('tasks');
  const [selectedTimelineDate, setSelectedTimelineDate] = useState<Date>(new Date());
  const [selectedTaskActionsId, setSelectedTaskActionsId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [condTargetId, setCondTargetId] = useState('');
  const [condReqId, setCondReqId] = useState('');
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);

  // Vibration and Custom Alarm Audio Settings
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [selectedAudioUrl, setSelectedAudioUrl] = useState('https://assets.mixkit.co/active_storage/sfx/941/941-preview.mp3');
  const [customSoundName, setCustomSoundName] = useState<string>('');

  // Preview state (audio separado do alarme real)
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);
  const previewAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const previewTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global States
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isHolidayMode, setIsHolidayMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Form State
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('12:00');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [weekdays, setWeekdays] = useState<DayOfWeek[]>([0, 1, 2, 3, 4, 5, 6]);
  const [advanceMinutes, setAdvanceMinutes] = useState(5);
  const [category, setCategory] = useState<Task['category']>('personal');
  const [dependencyId, setDependencyId] = useState<string>('');

  // Alarm State
  const [activeAlarm, setActiveAlarm] = useState<Task | null>(null);
  const wakeLockRef = React.useRef<any>(null);
  const audioUnlockedRef = React.useRef(false);

  const [audio] = useState<HTMLAudioElement | null>(() => {
    try {
      return new Audio('https://assets.mixkit.co/active_storage/sfx/941/941-preview.mp3');
    } catch (e) {
      console.warn('Audio initialization not supported in this context:', e);
      return null;
    }
  });
  
  useEffect(() => {
    if (audio) {
      audio.loop = true;
    }
  }, [audio]);

  // Desbloqueia o audio no primeiro toque (política de autoplay do browser)
  useEffect(() => {
    const unlock = () => {
      if (!audioUnlockedRef.current && audio) {
        audio.play()
          .then(() => { audio.pause(); audio.currentTime = 0; audioUnlockedRef.current = true; })
          .catch(() => {});
      }
    };
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('click', unlock, { once: true });
    return () => {
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
  }, [audio]);

  // Quando activeAlarm é definido (de QUALQUER caminho: polling, listener, tap na notificação)
  // → inicia áudio em loop + vibração contínua
  useEffect(() => {
    if (!activeAlarm) return;

    // Inicia áudio com retry (autoplay pode estar bloqueado na 1ª tentativa)
    if (audio) {
      audio.currentTime = 0;
      audio.loop = true;
      const tryPlay = (attempts = 0) => {
        audio.play().catch(() => {
          if (attempts < 8) setTimeout(() => tryPlay(attempts + 1), 700);
        });
      };
      tryPlay();
    }

    // Vibração contínua: 800ms ON / 400ms OFF
    if (vibrationEnabled) {
      const vibrate = () => {
        if ('vibrate' in navigator) navigator.vibrate([800, 400, 800, 400, 800, 400, 800, 400, 800]);
      };
      vibrate();
      const vibrateInterval = setInterval(vibrate, 6000);
      return () => {
        clearInterval(vibrateInterval);
        if ('vibrate' in navigator) navigator.vibrate(0);
      };
    }
  }, [activeAlarm, audio, vibrationEnabled]);

  // WakeLock: mantém tela acesa durante o alarme
  useEffect(() => {
    if (activeAlarm) {
      if ('wakeLock' in navigator) {
        (navigator as any).wakeLock.request('screen')
          .then((lock: any) => { wakeLockRef.current = lock; })
          .catch(() => {});
      }
    } else {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    }
  }, [activeAlarm]);

  useEffect(() => {
    if (audio) {
      audio.src = selectedAudioUrl;
    }
  }, [selectedAudioUrl, audio]);

  // --- Persistence ---
  useEffect(() => {
    const savedTasks = localStorage.getItem('silent_tasks');
    const savedHistory = localStorage.getItem('silent_history');
    const savedHoliday = localStorage.getItem('silent_holiday');
    const savedVibration = localStorage.getItem('silent_vibration');
    const savedAudio = localStorage.getItem('silent_audio_url');
    
    if (savedTasks) setTasks(JSON.parse(savedTasks));
    if (savedHistory) setHistory(JSON.parse(savedHistory));
    if (savedHoliday) setIsHolidayMode(JSON.parse(savedHoliday));
    if (savedVibration) setVibrationEnabled(JSON.parse(savedVibration));
    if (savedAudio) setSelectedAudioUrl(savedAudio);

    // Carrega nome do toque personalizado se houver
    const savedCustomName = localStorage.getItem('silent_custom_sound_name');
    if (savedCustomName) setCustomSoundName(savedCustomName);
  }, []);

  useEffect(() => {
    localStorage.setItem('silent_tasks', JSON.stringify(tasks));
    localStorage.setItem('silent_history', JSON.stringify(history));
    localStorage.setItem('silent_holiday', JSON.stringify(isHolidayMode));
    localStorage.setItem('silent_vibration', JSON.stringify(vibrationEnabled));
    localStorage.setItem('silent_audio_url', selectedAudioUrl);
  }, [tasks, history, isHolidayMode, vibrationEnabled, selectedAudioUrl]);

  // --- Notification Permission ---
  const checkPermissions = useCallback(async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        const status = await LocalNotifications.checkPermissions();
        if (status.display !== 'granted') {
          setShowPermissionPrompt(true);
        }
      } else if (typeof Notification !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'default') {
          setShowPermissionPrompt(true);
        }
      }
    } catch (e) {
      console.warn('Erro ao verificar permissões de notificação:', e);
    }
  }, []);

  const requestPermissions = async () => {
    setShowPermissionPrompt(false);
    try {
      if (Capacitor.isNativePlatform()) {
        const status = await LocalNotifications.requestPermissions();
        if (status.display !== 'granted') {
          console.log('Permissões de notificação negadas no Android.');
        }
      } else if (typeof Notification !== 'undefined' && 'Notification' in window && typeof Notification.requestPermission === 'function') {
        const status = await Notification.requestPermission();
        if (status !== 'granted') {
          console.log('Permissões de notificação negadas na Web.');
        }
      }
    } catch (e) {
      console.warn('Erro ao solicitar permissões de notificação:', e);
    }
  };

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  // --- Setup Android: Canal de Alta Prioridade + Listeners de Notificação ---
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Cria canal de alarme com IMPORTANCE_HIGH (obrigatório Android 8+)
    LocalNotifications.createChannel({
      id: 'alarm',
      name: 'Alarmes',
      importance: 5, // IMPORTANCE_HIGH
      visibility: 1, // PUBLIC - aparece na tela de bloqueio
      vibration: true,
      lights: true,
      lightColor: '#FF5555',
    }).catch(() => {});

    // Ouve notificação RECEBIDA enquanto app está em primeiro plano
    const receivedSub = LocalNotifications.addListener(
      'localNotificationReceived',
      (notification) => {
        const taskId = (notification.extra as any)?.taskId;
        if (!taskId) return;
        setTasks(prev => {
          const task = prev.find(t => t.id === taskId);
          if (task && task.isActive) {
            setTimeout(() => setActiveAlarm(task), 0);
          }
          return prev;
        });
      }
    );

    // Ouve toque do usuário na notificação (app em background ou fechado)
    const actionSub = LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) => {
        const taskId = (action.notification.extra as any)?.taskId;
        if (!taskId) return;
        setTasks(prev => {
          const task = prev.find(t => t.id === taskId);
          if (task) {
            setTimeout(() => setActiveAlarm(task), 0);
          }
          return prev;
        });
      }
    );

    return () => {
      receivedSub.then(s => s.remove()).catch(() => {});
      actionSub.then(s => s.remove()).catch(() => {});
    };
  }, []);

  // Agenda notificações nativas no horário EXATO de cada tarefa
  // Funciona mesmo com o app completamente fechado
  const scheduleNativeAlarmsForTasks = useCallback(async (taskList: Task[]) => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      // Cancela agendamentos anteriores (exceto o widget persistente id=999)
      const pending = await LocalNotifications.getPending();
      const toCancel = pending.notifications
        .filter(n => n.id !== 999)
        .map(n => ({ id: n.id }));
      if (toCancel.length > 0) {
        await LocalNotifications.cancel({ notifications: toCancel });
      }

      const now = new Date();
      const toSchedule: any[] = [];

      for (const task of taskList) {
        if (!task.isActive) continue;

        const nextOcc = getNextOccurrence(task, now);
        const notifTime = addMinutes(nextOcc, -task.advanceMinutes);

        // Agenda apenas no futuro
        if (notifTime > now) {
          const advMsg = task.advanceMinutes > 0
            ? `Inicia em ${task.advanceMinutes}min (às ${task.time})`
            : `É hora de: ${task.title}`;
          toSchedule.push({
            title: `⏰ ${task.title}`,
            body: advMsg,
            id: taskToNotifId(task.id),
            schedule: { at: notifTime, allowWhileIdle: true },
            channelId: 'alarm',
            extra: { taskId: task.id },
          });
        }
      }

      if (toSchedule.length > 0) {
        await LocalNotifications.schedule({ notifications: toSchedule });
      }
    } catch (e) {
      console.warn('Erro ao agendar alarmes nativos:', e);
    }
  }, []);

  // Re-agenda sempre que as tarefas mudarem
  useEffect(() => {
    scheduleNativeAlarmsForTasks(tasks);
  }, [tasks, scheduleNativeAlarmsForTasks]);

  // --- Background Logic (Every 30s) ---
  // Ref para manter sempre os valores mais recentes sem invalidar o interval
  const notifStateRef = React.useRef({ isHolidayMode, history });
  useEffect(() => {
    notifStateRef.current = { isHolidayMode, history };
  }, [isHolidayMode, history]);

  // sendNotificationRef garante que o checkNotifications sempre usa a versão atual
  const sendNotificationRef = React.useRef<(task: Task) => void>(() => {});

  const checkNotifications = useCallback(() => {
    const now = new Date();
    const currentDay = now.getDay();
    const { isHolidayMode: holidayMode, history: hist } = notifStateRef.current;

    // Coleta as tarefas a notificar FORA do updater para evitar setState dentro de setState
    const tasksToNotify: Task[] = [];

    setTasks(prevTasks => {
      let changed = false;
      const updatedTasks = prevTasks.map(task => {
        if (!task.isActive) return task;

        // Skip routines in Holiday Mode
        if (holidayMode && task.type === 'routine') return task;

        // Check Snooze
        if (task.snoozedUntil && new Date(task.snoozedUntil) > now) return task;

        // Check Dependency (Task Condition)
        if (task.dependencyId) {
          const wasDependentCompleted = hist.some(h => 
            h.taskId === task.dependencyId && isSameDay(parseISO(h.completedAt), now)
          );
          if (!wasDependentCompleted) return task;
        }

        // Calculate target time with advance
        const [hours, minutes] = task.time.split(':').map(Number);
        const targetToday = new Date(now);
        targetToday.setHours(hours, minutes, 0, 0);
        
        const notificationTime = addMinutes(targetToday, -task.advanceMinutes);
        
        // Conditions for notification
        let shouldNotify = false;

        if (task.type === 'routine') {
          const isToday = task.weekdays?.includes(currentDay as DayOfWeek);
          if (isToday) {
            // Janela de disparo robusta de 10 minutos (suporta inclusive 0m de antecedência e previne pulos)
            if (now >= notificationTime && now < addMinutes(notificationTime, 10)) {
              const lastDate = task.lastNotifiedAt ? new Date(task.lastNotifiedAt) : null;
              if (!lastDate || !isSameDay(lastDate, now)) {
                shouldNotify = true;
              }
            }
          }
        } else {
          // Usa parseLocalDate para evitar bug de timezone (parseISO trata YYYY-MM-DD como UTC midnight)
          if (task.date && isSameDay(parseLocalDate(task.date), now)) {
            // Janela de disparo robusta de 10 minutos (suporta inclusive 0m de antecedência e previne pulos)
            if (now >= notificationTime && now < addMinutes(notificationTime, 10)) {
              const lastDate = task.lastNotifiedAt ? new Date(task.lastNotifiedAt) : null;
              if (!lastDate || !isSameDay(lastDate, now)) {
                shouldNotify = true;
              }
            }
          }
        }

        if (shouldNotify) {
          tasksToNotify.push(task); // Coleta para disparar FORA do updater
          changed = true;
          return { ...task, lastNotifiedAt: now.toISOString(), snoozedUntil: undefined };
        }

        return task;
      });

      return changed ? updatedTasks : prevTasks;
    });

    // Dispara notificações APÓS o update de estado (setTimeout 0 = próximo tick)
    // Isso evita chamar setState (setActiveAlarm) dentro de um setState updater
    if (tasksToNotify.length > 0) {
      setTimeout(() => {
        tasksToNotify.forEach(task => sendNotificationRef.current(task));
      }, 0);
    }
  }, []); // Deps vazio = interval NUNCA reseta, usa ref para valores atuais

  // --- Persistent "Widget" Notification ---
  const updatePersistentWidget = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return;

    const now = new Date();
    const todayTasks = sortedTasks.filter(t => {
      if (!t.isActive) return false;
      if (isHolidayMode && t.type === 'routine') return false;
      return true;
    });

    if (todayTasks.length === 0) {
      await LocalNotifications.cancel({ notifications: [{ id: 999 }] });
      return;
    }

    const nextTask = todayTasks[0]; // Already sorted by time
    
    await LocalNotifications.schedule({
      notifications: [
        {
          title: 'Próxima Tarefa',
          body: `${nextTask.time} - ${nextTask.title}`,
          id: 999,
          ongoing: true, // This makes it a persistent "widget"
          autoCancel: false,
          silent: true,
          smallIcon: 'ic_stat_name', // Needs to be in android resources
        }
      ]
    });
  }, [sortedTasks, isHolidayMode]);

  useEffect(() => {
    updatePersistentWidget();
  }, [updatePersistentWidget]);

  const sendNotification = async (task: Task) => {
    const advMsg = task.advanceMinutes > 0
      ? `em ${task.advanceMinutes}min (às ${task.time})`
      : `às ${task.time}`;
    const message = `⏰ ${task.title} - ${advMsg}`;
    
    // Mostra overlay fullscreen → o useEffect do activeAlarm cuida do áudio e vibração
    setActiveAlarm(task);

    // Native Capacitor (APK Android)
    if (Capacitor.isNativePlatform()) {
      if (vibrationEnabled) Haptics.impact({ style: ImpactStyle.Heavy });
      // Fallback imediato (a notif agendada já foi disparada pelo Android)
      await LocalNotifications.schedule({
        notifications: [{
          title: `⏰ ${task.title}`,
          body: message,
          id: taskToNotifId(task.id) + 1000000,
          schedule: { at: new Date(Date.now() + 100) },
          channelId: 'alarm',
          extra: { taskId: task.id },
          attachments: [],
          extra2: null
        }]
      });
    } else {
      // Web: vibração via Web API
      if (vibrationEnabled && 'vibrate' in navigator) {
        navigator.vibrate([800, 400, 800, 400, 800]);
      }
      // Web Notification (sistema)
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const notifOptions: any = { body: message, icon: '/app_icon.png', requireInteraction: true };
          try {
            new Notification('⏰ Alarme Silencioso', notifOptions);
          } catch {
            if (navigator.serviceWorker?.ready) {
              const reg = await navigator.serviceWorker.ready;
              reg.showNotification('⏰ Alarme Silencioso', notifOptions);
            }
          }
        }
      } catch (e) {
        console.warn('Erro ao enviar notificação Web:', e);
      }
    }
  };

  const stopAlarm = () => {
    if (audio) { audio.pause(); audio.currentTime = 0; }
    // Para vibração imediatamente
    if ('vibrate' in navigator) navigator.vibrate(0);
    // Libera WakeLock
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
    setActiveAlarm(null);
  };

  const completeTask = (task: Task) => {
    const newItem: HistoryItem = {
      id: generateId(),
      taskId: task.id,
      title: task.title,
      completedAt: new Date().toISOString(),
      category: task.category,
      status: 'completed',
    };
    setHistory([newItem, ...history]);
    stopAlarm();
  };

  const declineTask = (task: Task) => {
    const newItem: HistoryItem = {
      id: generateId(),
      taskId: task.id,
      title: task.title,
      completedAt: new Date().toISOString(),
      category: task.category,
      status: 'declined',
    };
    setHistory([newItem, ...history]);
    stopAlarm();
  };

  const snoozeAlarm = () => {
    if (!activeAlarm) return;
    const snoozeTime = addMinutes(new Date(), 5);
    setTasks(tasks.map(t => t.id === activeAlarm.id ? { ...t, snoozedUntil: snoozeTime.toISOString() } : t));
    stopAlarm();
  };

  // --- Preview de som nas configurações ---
  const playPreview = (url: string) => {
    // Para preview anterior se houver
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (!previewAudioRef.current) previewAudioRef.current = new Audio();
    const prev = previewAudioRef.current;
    prev.pause();
    prev.src = url;
    prev.currentTime = 0;
    prev.loop = false;
    prev.play().catch(() => {});
    setPreviewingUrl(url);
    // Para automaticamente após 4 segundos
    previewTimerRef.current = setTimeout(() => {
      prev.pause();
      prev.currentTime = 0;
      setPreviewingUrl(null);
    }, 4000);
  };

  const stopPreview = () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
    }
    setPreviewingUrl(null);
  };

  // --- Upload de toque personalizado ---
  const handleCustomAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      try {
        localStorage.setItem('silent_audio_url', base64);
        localStorage.setItem('silent_custom_sound_name', file.name);
        setSelectedAudioUrl(base64);
        setCustomSoundName(file.name);
      } catch {
        // Fallback se localStorage estiver cheio (arquivo muito grande)
        const objUrl = URL.createObjectURL(file);
        setSelectedAudioUrl(objUrl);
        setCustomSoundName(file.name + ' (não salvo)');
      }
    };
    reader.readAsDataURL(file);
    // Limpa o input pra permitir reselecionar o mesmo arquivo
    e.target.value = '';
  };

  // Mantém sendNotificationRef sempre apontando para a versão mais recente de sendNotification
  // Sem deps = roda após cada render, garantindo que o ref nunca fica stale
  useEffect(() => {
    sendNotificationRef.current = sendNotification;
  });

  useEffect(() => {
    const interval = setInterval(checkNotifications, 30000);
    checkNotifications(); // Run immediately on mount
    return () => clearInterval(interval);
  }, [checkNotifications]);

  // --- Handlers ---
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const newTask: Task = {
      id: editingTask?.id || generateId(),
      type: activeTab,
      title,
      time,
      date: activeTab === 'event' ? date : undefined,
      weekdays: activeTab === 'routine' ? weekdays : undefined,
      advanceMinutes,
      isActive: editingTask ? editingTask.isActive : true,
      category,
      dependencyId: dependencyId || undefined,
    };

    if (editingTask) {
      setTasks(tasks.map(t => t.id === editingTask.id ? newTask : t));
    } else {
      setTasks([newTask, ...tasks]);
    }

    resetForm();
  };

  const resetForm = () => {
    setTitle('');
    setTime('12:00');
    setDate(format(new Date(), 'yyyy-MM-dd'));
    setWeekdays([0, 1, 2, 3, 4, 5, 6]);
    setAdvanceMinutes(5);
    setCategory('personal');
    setDependencyId('');
    setIsAdding(false);
    setEditingTask(null);
  };

  const toggleTask = (id: string) => {
    setTasks(tasks.map(t => t.id === id ? { ...t, isActive: !t.isActive } : t));
  };

  const deleteTask = (id: string) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  const startEdit = (task: Task) => {
    setEditingTask(task);
    setActiveTab(task.type);
    setTitle(task.title);
    setTime(task.time);
    if (task.date) setDate(task.date);
    if (task.weekdays) setWeekdays(task.weekdays);
    setAdvanceMinutes(task.advanceMinutes);
    setCategory(task.category);
    setDependencyId(task.dependencyId || '');
    setIsAdding(true);
  };

  const toggleWeekday = (day: DayOfWeek) => {
    setWeekdays(prev => 
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  };

  // --- Helper Functions for Tab Pages ---
  const copyLinkToClipboard = () => {
    navigator.clipboard.writeText(window.location.origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleQuickBind = (e: React.FormEvent) => {
    e.preventDefault();
    if (!condTargetId || !condReqId || condTargetId === condReqId) return;

    setTasks(tasks.map(t => t.id === condTargetId ? { ...t, dependencyId: condReqId } : t));
    
    // Limpa a seleção
    setCondTargetId('');
    setCondReqId('');
    
    if (Capacitor.isNativePlatform()) {
      Haptics.impact({ style: ImpactStyle.Light });
    }
  };

  const handleUnbind = (taskId: string) => {
    setTasks(tasks.map(t => t.id === taskId ? { ...t, dependencyId: undefined } : t));
    if (Capacitor.isNativePlatform()) {
      Haptics.impact({ style: ImpactStyle.Light });
    }
  };

  // Estatísticas do Histórico
  const completedToday = history.filter(item => {
    try {
      return isSameDay(parseISO(item.completedAt), new Date()) && item.status === 'completed';
    } catch (e) {
      return false;
    }
  }).length;

  const declinedToday = history.filter(item => {
    try {
      return isSameDay(parseISO(item.completedAt), new Date()) && item.status === 'declined';
    } catch (e) {
      return false;
    }
  }).length;

  const totalCompleted = history.filter(item => item.status === 'completed').length;

  const categoryCounts = history
    .filter(item => item.status === 'completed')
    .reduce((acc, curr) => {
      acc[curr.category] = (acc[curr.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

  const mostFrequentCategoryKey = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0];
  const mostFrequentCategory = mostFrequentCategoryKey ? CATEGORIES[mostFrequentCategoryKey as keyof typeof CATEGORIES]?.label : 'Nenhuma';

  // --- GERADORES DA LINHA DO TEMPO (TIMELINE) ---
  const timelineDays = React.useMemo(() => {
    const dates = [];
    const today = new Date();
    // Gera 7 dias em volta de hoje (2 dias atrás, hoje, 4 dias adiante)
    for (let i = -2; i <= 4; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }
    return dates;
  }, []);

  const timelineTasksForSelectedDay = React.useMemo(() => {
    const dayOfWeek = selectedTimelineDate.getDay() as DayOfWeek;
    const dateString = format(selectedTimelineDate, 'yyyy-MM-dd');
    
    return tasks.filter(task => {
      if (!task.isActive) return false;
      if (task.type === 'routine') {
        if (isHolidayMode) return false; // Modo férias silencia rotinas
        return !task.weekdays || task.weekdays.length === 0 || task.weekdays.includes(dayOfWeek);
      } else {
        return task.date === dateString;
      }
    }).sort((a, b) => a.time.localeCompare(b.time));
  }, [tasks, selectedTimelineDate, isHolidayMode]);

  const getTimelineStatus = (taskId: string, dayDate: Date) => {
    const record = history.find(h => 
      h.taskId === taskId && 
      isSameDay(parseISO(h.completedAt), dayDate)
    );
    return record?.status; // 'completed' | 'declined' | undefined
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8 flex justify-center pb-[calc(env(safe-area-inset-bottom,16px)+110px)]">
      <div className="w-full max-w-2xl">
        
        {/* --- ABA 1: TAREFAS --- */}
        {currentTab === 'tasks' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* Header */}
            <header className="flex items-center justify-between mb-8">
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
                  Barulhento
                </h1>
                <div className="flex items-center gap-3 mt-1">
                  <p className="text-zinc-500 text-sm">Gerencie seu tempo com inteligência.</p>
                  <button 
                    onClick={() => setIsHolidayMode(!isHolidayMode)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-all",
                      isHolidayMode ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" : "bg-zinc-800 text-zinc-500 border border-zinc-700"
                    )}
                  >
                    {isHolidayMode ? 'Modo Férias Ativo' : 'Modo Férias'}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => setIsAdding(true)}
                  aria-label="Adicionar Tarefa"
                  className="p-3 bg-primary-600 hover:bg-primary-500 rounded-full shadow-lg shadow-primary-900/20 transition-all active:scale-95 flex items-center justify-center"
                >
                  <Plus size={24} />
                </button>
              </div>
            </header>

            {/* Widget / Dashboard */}
            {sortedTasks.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-6 bg-gradient-to-br from-primary-600/20 to-primary-900/10 border border-primary-500/20 rounded-[2rem] flex items-center justify-between shadow-xl"
              >
                <div>
                  <p className="text-primary-400 text-[10px] font-bold uppercase tracking-wider mb-1">Próxima Atividade</p>
                  <h2 className="text-2xl font-bold text-white">
                    {sortedTasks.find(t => t.isActive && (!isHolidayMode || t.type !== 'routine'))?.title || 'Nenhuma ativa'}
                  </h2>
                  <p className="text-zinc-500 text-sm mt-1 flex items-center gap-1">
                    <Clock size={14} /> às {sortedTasks.find(t => t.isActive && (!isHolidayMode || t.type !== 'routine'))?.time || '--:--'}
                  </p>
                </div>
                <div className="bg-primary-500 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg shadow-primary-500/20">
                  <Bell className="text-white animate-pulse" size={28} />
                </div>
              </motion.div>
            )}

            {/* Task List */}
            <div className="space-y-4">
              <AnimatePresence mode="popLayout">
                {tasks.length === 0 && !isAdding && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center justify-center py-20 text-zinc-600"
                  >
                    <Clock size={48} className="mb-4 opacity-20" />
                    <p>Nenhuma tarefa agendada.</p>
                    <button 
                      onClick={() => setIsAdding(true)}
                      className="mt-4 text-primary-500 hover:underline text-sm font-semibold"
                    >
                      Criar minha primeira rotina
                    </button>
                  </motion.div>
                )}

                {sortedTasks.map((task) => {
                  const isMenuOpen = selectedTaskActionsId === task.id;
                  let pressTimer: any = null;
                  
                  const handleStart = () => {
                    pressTimer = setTimeout(() => {
                      try {
                        Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
                      } catch (e) {}
                      setSelectedTaskActionsId(task.id);
                    }, 500);
                  };
                  
                  const handleEnd = () => {
                    if (pressTimer) clearTimeout(pressTimer);
                  };

                  return (
                    <motion.div
                      key={task.id}
                      layout
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      onTouchStart={handleStart}
                      onTouchEnd={handleEnd}
                      onMouseDown={handleStart}
                      onMouseUp={handleEnd}
                      onMouseLeave={handleEnd}
                      className={cn(
                        "glass p-3.5 pl-4 pr-3 rounded-2xl flex flex-col gap-2 group transition-all relative overflow-hidden select-none cursor-pointer",
                        (!task.isActive || (isHolidayMode && task.type === 'routine')) && "opacity-50 grayscale-[0.3]"
                      )}
                    >
                      {/* Category accent bar */}
                      <div className={cn("absolute left-0 top-0 bottom-0 w-1", CATEGORIES[task.category].color)} />

                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 flex-shrink-0">
                            {task.type === 'routine' ? <RotateCcw size={16} /> : <Calendar size={16} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-semibold text-sm text-zinc-100 truncate max-w-[150px] sm:max-w-xs">{task.title}</h3>
                              <span className={cn("text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase", CATEGORIES[task.category].color, "bg-opacity-20", CATEGORIES[task.category].text)}>
                                {CATEGORIES[task.category].label}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-0.5 flex-wrap">
                              <span className="flex items-center gap-1 font-mono text-zinc-300">
                                <Clock size={10} /> {task.time}
                              </span>
                              {task.type === 'routine' ? (
                                <span className="flex gap-0.5">
                                  {DAYS.map(d => (
                                    <span 
                                      key={d.value}
                                      className={cn(
                                        "w-3.5 h-3.5 flex items-center justify-center rounded-[2px] text-[8px]",
                                        task.weekdays?.includes(d.value as DayOfWeek) ? "bg-zinc-700 text-zinc-300 font-bold" : "text-zinc-800"
                                      )}
                                    >
                                      {d.label}
                                    </span>
                                  ))}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 uppercase text-[9px]">
                                  <Calendar size={10} /> {task.date && format(parseISO(task.date), 'dd MMM', { locale: ptBR })}
                                </span>
                              )}
                              <span className="flex items-center gap-0.5 text-primary-400">
                                <Bell size={10} /> -{task.advanceMinutes}m
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Right side: Three dots menu trigger */}
                        <div className="flex items-center gap-1.5 flex-shrink-0 z-10">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTaskActionsId(isMenuOpen ? null : task.id);
                            }}
                            className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
                            title="Ações"
                          >
                            <MoreVertical size={16} />
                          </button>
                        </div>
                      </div>

                      {/* Snooze/Dependency Condition (if any) */}
                      {task.dependencyId && (
                        <div className="flex items-center gap-1 text-[9px] text-zinc-500 italic pl-9">
                          <Sliders size={8} className="text-primary-400" />
                          <span>
                            Depende de: <strong className="text-zinc-400">"{tasks.find(t => t.id === task.dependencyId)?.title}"</strong>
                          </span>
                        </div>
                      )}

                      {/* Manual conclusion status/actions */}
                      {task.isActive && (!isHolidayMode || task.type !== 'routine') && (() => {
                        const todayRecord = history.find(h =>
                          h.taskId === task.id &&
                          (() => { try { return isSameDay(parseISO(h.completedAt), new Date()); } catch { return false; } })()
                        );
                        if (todayRecord) {
                          return (
                            <div className="pt-2 border-t border-zinc-800/30 flex items-center justify-between text-[11px] mt-0.5">
                              <span className="text-zinc-500 font-medium">Hoje:</span>
                              <span className={cn(
                                "px-2 py-0.5 rounded-lg font-bold flex items-center gap-1 text-[10px]",
                                todayRecord.status === 'completed'
                                  ? "bg-green-500/10 text-green-400 border border-green-500/20"
                                  : "bg-red-500/10 text-red-400 border border-red-500/20"
                              )}>
                                {todayRecord.status === 'completed' ? <><CheckCircle2 size={10} /> Feito</> : <><X size={10} /> Não fiz</>}
                              </span>
                            </div>
                          );
                        }
                        return (
                          <div className="pt-2 border-t border-zinc-800/30 flex items-center justify-between text-[11px] mt-0.5">
                            <span className="text-zinc-500 font-medium">Hoje:</span>
                            <div className="flex gap-1.5">
                              <button
                                onClick={(e) => { e.stopPropagation(); completeTask(task); }}
                                className="px-2 py-1 bg-green-500/10 hover:bg-green-500/25 text-green-400 font-bold rounded-lg border border-green-500/20 transition-all flex items-center gap-1 active:scale-95 text-[10px]"
                              >
                                <CheckCircle2 size={10} /> Feito
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); declineTask(task); }}
                                className="px-2 py-1 bg-red-500/10 hover:bg-red-500/25 text-red-400 font-bold rounded-lg border border-red-500/20 transition-all flex items-center gap-1 active:scale-95 text-[10px]"
                              >
                                <X size={10} /> Não fiz
                              </button>
                            </div>
                          </div>
                        );
                      })()}

                      {/* --- ABSOLUTE QUICK ACTIONS SLIDE-OVER --- */}
                      <AnimatePresence>
                        {isMenuOpen && (
                          <motion.div
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute inset-y-0 right-0 left-0 bg-zinc-950/95 backdrop-blur-md z-20 flex items-center justify-between pl-4 pr-3 border-l border-zinc-800"
                          >
                            <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider truncate max-w-[80px]">
                              {task.title}
                            </span>
                            
                            <div className="flex items-center gap-1">
                              {/* Toggle Active */}
                              <button
                                onClick={() => {
                                  toggleTask(task.id);
                                  setSelectedTaskActionsId(null);
                                }}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-xl text-[10px] font-bold transition-all flex items-center gap-1",
                                  task.isActive ? "bg-green-500/15 text-green-400 border border-green-500/20" : "bg-zinc-800 text-zinc-500"
                                )}
                              >
                                {task.isActive ? <CheckCircle2 size={12} /> : <BellOff size={12} />}
                                {task.isActive ? 'Ativo' : 'Inativo'}
                              </button>

                              {/* Edit */}
                              <button
                                onClick={() => {
                                  startEdit(task);
                                  setSelectedTaskActionsId(null);
                                }}
                                className="p-2 text-primary-400 bg-primary-500/10 hover:bg-primary-500/20 rounded-xl transition-colors border border-primary-500/20"
                                title="Editar"
                              >
                                <Edit2 size={14} />
                              </button>

                              {/* Delete */}
                              <button
                                onClick={() => {
                                  deleteTask(task.id);
                                  setSelectedTaskActionsId(null);
                                }}
                                className="p-2 text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-xl transition-colors border border-red-500/20"
                                title="Excluir"
                              >
                                <Trash2 size={14} />
                              </button>

                              {/* Close actions */}
                              <button
                                onClick={() => setSelectedTaskActionsId(null)}
                                className="p-2 hover:bg-zinc-800 rounded-xl text-zinc-400 transition-colors ml-1"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {/* --- ABA NEW: LINHA DO TEMPO (TIMELINE) --- */}
        {currentTab === 'timeline' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* Header */}
            <header className="mb-6 flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                  <Calendar className="text-primary-500" size={24} /> Linha do Tempo
                </h2>
                <p className="text-zinc-500 text-sm mt-1">Acompanhe a sequência dos alarmes do dia.</p>
              </div>
            </header>

            {/* Horizontal Date Selector */}
            <div className="flex gap-2.5 overflow-x-auto pb-3 pt-1 scrollbar-thin px-1">
              {timelineDays.map((dayDate) => {
                const isSelected = isSameDay(dayDate, selectedTimelineDate);
                const isToday = isSameDay(dayDate, new Date());
                const dayLabel = format(dayDate, 'EEE', { locale: ptBR }).replace('.', '');
                const dayNum = format(dayDate, 'dd');

                return (
                  <button
                    key={dayDate.toISOString()}
                    onClick={() => setSelectedTimelineDate(dayDate)}
                    className={cn(
                      "flex-shrink-0 flex flex-col items-center justify-center w-14 h-18 rounded-2xl border transition-all active:scale-95",
                      isSelected
                        ? "bg-primary-600 border-primary-500 text-white shadow-lg shadow-primary-900/20"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                    )}
                  >
                    <span className="text-[10px] font-bold uppercase tracking-wider mb-1">{dayLabel}</span>
                    <span className="text-lg font-black">{dayNum}</span>
                    {isToday && (
                      <span className={cn("w-1.5 h-1.5 rounded-full mt-1", isSelected ? "bg-white" : "bg-primary-500")} />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Selected Date Header */}
            <div className="text-center py-2 border-y border-zinc-900/50 bg-zinc-950/20 rounded-xl my-2">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">
                {format(selectedTimelineDate, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
              </span>
            </div>

            {/* Timeline Task Sequence */}
            <div className="relative pl-6 space-y-6 before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-zinc-800">
              {timelineTasksForSelectedDay.length === 0 ? (
                <div className="text-center py-16 text-zinc-600 space-y-2 pr-6">
                  <Calendar size={40} className="mx-auto opacity-15" />
                  <p className="text-xs italic">Nenhum alarme ativo programado para este dia.</p>
                </div>
              ) : (
                timelineTasksForSelectedDay.map((task) => {
                  const status = getTimelineStatus(task.id, selectedTimelineDate);
                  const isToday = isSameDay(selectedTimelineDate, new Date());
                  const isFutureDay = !isToday && selectedTimelineDate > new Date();
                  const isPastDay = !isToday && selectedTimelineDate < new Date();
                  
                  return (
                    <div key={task.id} className="relative flex flex-col gap-2">
                      {/* Timeline Dot Icon */}
                      <span className={cn(
                        "absolute left-[-21px] top-1.5 w-3 h-3 rounded-full border-2 border-background z-10 transition-all",
                        status === 'completed' ? "bg-green-500" :
                        status === 'declined' ? "bg-red-500" :
                        CATEGORIES[task.category].color
                      )} />

                      <div className="glass p-3 rounded-xl border border-zinc-800 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span className="text-sm font-mono font-bold text-primary-400 bg-primary-950/40 border border-primary-900/30 px-2 py-0.5 rounded-lg">
                            {task.time}
                          </span>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-bold text-zinc-100 truncate">{task.title}</h4>
                            <span className={cn("text-[8px] px-1 py-0 rounded-full font-bold uppercase inline-block mt-0.5", CATEGORIES[task.category].color, "bg-opacity-20", CATEGORIES[task.category].text)}>
                              {CATEGORIES[task.category].label}
                            </span>
                          </div>
                        </div>

                        {/* Status Indicator / Quick Action */}
                        <div className="flex-shrink-0">
                          {status === 'completed' ? (
                            <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-1 rounded-lg flex items-center gap-1">
                              <CheckCircle2 size={10} /> Feito
                            </span>
                          ) : status === 'declined' ? (
                            <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-lg flex items-center gap-1">
                              <X size={10} /> Não fiz
                            </span>
                          ) : isToday ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => completeTask(task)}
                                className="px-2 py-1 bg-green-500/10 hover:bg-green-500/25 text-green-400 font-bold rounded-lg border border-green-500/20 transition-all text-[10px]"
                              >
                                Feito
                              </button>
                              <button
                                onClick={() => declineTask(task)}
                                className="px-2 py-1 bg-red-500/10 hover:bg-red-500/25 text-red-400 font-bold rounded-lg border border-red-500/20 transition-all text-[10px]"
                              >
                                Não fiz
                              </button>
                            </div>
                          ) : isPastDay ? (
                            <span className="text-[9px] font-bold text-zinc-600 bg-zinc-950/40 border border-zinc-900 px-2 py-1 rounded-lg">
                              Perdido
                            </span>
                          ) : (
                            <span className="text-[9px] font-bold text-primary-400/80 bg-primary-950/20 border border-primary-900/20 px-2 py-1 rounded-lg">
                              Agendado
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}

        {/* --- ABA 2: CONDIÇÕES & REGRAS --- */}
        {currentTab === 'conditions' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            <header className="mb-6">
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <Sliders className="text-primary-500" size={24} /> Condições e Regras
              </h2>
              <p className="text-zinc-500 text-sm mt-1">Dispare alarmes apenas quando necessário.</p>
            </header>

            {/* Didactic Explanation */}
            <div className="glass p-5 rounded-2xl border border-zinc-800/80 flex gap-4">
              <div className="p-3 bg-primary-600/10 text-primary-400 rounded-xl h-fit">
                <Info size={24} />
              </div>
              <div className="space-y-2">
                <h4 className="font-bold text-zinc-200 text-sm">Como funcionam as dependências?</h4>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Você pode configurar uma tarefa para ser dependente de outra. 
                  O alarme da <strong>Tarefa B</strong> só tocará se você já tiver marcado a <strong>Tarefa A</strong> como concluída no dia de hoje.
                </p>
                <div className="text-[10px] text-zinc-500 border-l-2 border-primary-500/40 pl-2 py-0.5">
                  <strong>Exemplo prático:</strong> Só disparar "Tomar Suplemento" se a tarefa "Treino Diário" já tiver sido realizada no dia.
                </div>
              </div>
            </div>

            {/* Bind Form */}
            <div className="glass p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-primary-400">Vincular Nova Condição</h3>
              
              {tasks.length < 2 ? (
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-zinc-800 text-center">
                  <p className="text-xs text-zinc-500">
                    Você precisa criar pelo menos duas tarefas na aba anterior para conseguir criar regras de dependência!
                  </p>
                </div>
              ) : (
                <form onSubmit={handleQuickBind} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-500 uppercase mb-2 ml-1">Tarefa Dependente (Alvo)</label>
                      <select
                        className="w-full text-sm bg-zinc-900/50"
                        value={condTargetId}
                        onChange={(e) => setCondTargetId(e.target.value)}
                        required
                      >
                        <option value="">Selecione a tarefa...</option>
                        {tasks.map(t => (
                          <option key={t.id} value={t.id}>{t.title} ({t.time})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-500 uppercase mb-2 ml-1">Só tocar se esta for concluída hoje (Requisito)</label>
                      <select
                        className="w-full text-sm bg-zinc-900/50"
                        value={condReqId}
                        onChange={(e) => setCondReqId(e.target.value)}
                        required
                      >
                        <option value="">Selecione a tarefa pré-requisito...</option>
                        {tasks
                          .filter(t => t.id !== condTargetId)
                          .map(t => (
                            <option key={t.id} value={t.id}>{t.title} ({t.time})</option>
                          ))}
                      </select>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={!condTargetId || !condReqId}
                    className="w-full py-3 bg-primary-600 hover:bg-primary-500 disabled:opacity-40 disabled:hover:bg-primary-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-primary-950/20 transition-all flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> VINCULAR REGRA DE DEPENDÊNCIA
                  </button>
                </form>
              )}
            </div>

            {/* Active Dependencies Visualizer */}
            <div className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500 ml-1">Regras Ativas</h3>
              {tasks.filter(t => t.dependencyId).length === 0 ? (
                <p className="text-xs text-zinc-600 italic ml-1">Nenhuma dependência criada no momento.</p>
              ) : (
                <div className="space-y-3">
                  {tasks
                    .filter(t => t.dependencyId)
                    .map(task => {
                      const req = tasks.find(t => t.id === task.dependencyId);
                      return (
                        <div 
                          key={task.id} 
                          className="glass p-4 rounded-xl border border-zinc-800/60 flex flex-col md:flex-row md:items-center justify-between gap-4"
                        >
                          <div className="flex items-center gap-3 text-sm flex-wrap">
                            {/* Requisito */}
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-lg font-medium text-xs">
                              <span className={cn("w-1.5 h-1.5 rounded-full", req ? CATEGORIES[req.category]?.color : "bg-zinc-500")} />
                              {req ? req.title : 'Tarefa excluída'}
                            </div>

                            {/* Seta indicativa */}
                            <span className="text-zinc-600 font-bold">➔</span>

                            {/* Dependente */}
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary-500/10 border border-primary-500/20 text-primary-400 rounded-lg font-medium text-xs">
                              <span className={cn("w-1.5 h-1.5 rounded-full", CATEGORIES[task.category]?.color)} />
                              {task.title}
                            </div>
                          </div>

                          <button
                            onClick={() => handleUnbind(task.id)}
                            className="px-3 py-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg text-xs font-semibold transition-colors"
                          >
                            Excluir Regra
                          </button>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* --- ABA 3: HISTÓRICO & PERFORMANCE --- */}
        {currentTab === 'history' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            <header className="mb-6 flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                  <History className="text-primary-500" size={24} /> Histórico de Atividades
                </h2>
                <p className="text-zinc-500 text-sm mt-1">Acompanhe suas rotinas concluídas e recusadas.</p>
              </div>
              {history.length > 0 && (
                <button
                  onClick={() => setHistory([])}
                  className="px-3 py-1.5 bg-zinc-900 hover:bg-red-500/10 border border-zinc-800 text-zinc-500 hover:text-red-400 text-xs font-semibold rounded-lg transition-colors"
                >
                  Limpar Tudo
                </button>
              )}
            </header>

            {/* Quick Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass p-5 rounded-2xl border border-zinc-800 text-center">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Total Feitas</p>
                <p className="text-3xl font-black text-white mt-1">{totalCompleted}</p>
              </div>
              <div className="glass p-5 rounded-2xl border border-zinc-800 text-center">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Hoje (Feito / Não)</p>
                <p className="text-3xl font-black text-green-400 mt-1">
                  {completedToday} <span className="text-zinc-500 font-normal text-xl">/</span> <span className="text-red-400">{declinedToday}</span>
                </p>
              </div>
              <div className="glass p-5 rounded-2xl border border-zinc-800 text-center">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Foco Principal</p>
                <p className="text-lg font-bold text-primary-400 mt-2 truncate">{mostFrequentCategory}</p>
              </div>
            </div>

            {/* Progress Log grouped by day */}
            <div className="glass p-6 rounded-[2rem] space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Diário de Atividades</h3>
              
              <div className="space-y-6 max-h-96 overflow-y-auto pr-2">
                {history.length === 0 ? (
                  <div className="text-center py-12 text-zinc-600 space-y-2">
                    <CheckCircle2 size={40} className="mx-auto opacity-10" />
                    <p className="text-xs italic">Nenhuma atividade registrada no histórico.</p>
                  </div>
                ) : (
                  (() => {
                    const grouped = history.reduce((groups, item) => {
                      try {
                        const dateStr = format(parseISO(item.completedAt), 'yyyy-MM-dd');
                        if (!groups[dateStr]) groups[dateStr] = [];
                        groups[dateStr].push(item);
                      } catch (e) {}
                      return groups;
                    }, {} as Record<string, typeof history>);

                    const sortedDays = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

                    return sortedDays.map(dayStr => {
                      const items = grouped[dayStr];
                      const dayDate = parseISO(dayStr);
                      return (
                        <div key={dayStr} className="space-y-3">
                          <h4 className="text-xs font-bold text-primary-400/80 uppercase tracking-wider border-b border-zinc-800/40 pb-1.5 mt-2">
                            {format(dayDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}
                          </h4>
                          <div className="space-y-2">
                            {items.map(item => (
                              <div key={item.id} className="flex items-center justify-between py-2 border-b border-zinc-900/40 last:border-0 pl-1">
                                <div className="flex items-center gap-3">
                                  {item.status === 'completed' ? (
                                    <div className="w-6 h-6 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center text-green-400 shadow-sm" title="Tarefa Concluída">
                                      <CheckCircle2 size={14} />
                                    </div>
                                  ) : (
                                    <div className="w-6 h-6 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shadow-sm" title="Tarefa Recusada/Ignorada">
                                      <X size={14} />
                                    </div>
                                  )}
                                  <div>
                                    <p className="text-sm font-semibold text-zinc-100">{item.title}</p>
                                    <p className="text-[10px] text-zinc-500 mt-0.5">
                                      Registrado às {format(parseISO(item.completedAt), 'HH:mm')}
                                    </p>
                                  </div>
                                </div>
                                <span className={cn("text-[9px] px-2 py-0.5 rounded-full font-bold uppercase", CATEGORIES[item.category as keyof typeof CATEGORIES]?.color, "bg-opacity-20", CATEGORIES[item.category as keyof typeof CATEGORIES]?.text)}>
                                  {CATEGORIES[item.category as keyof typeof CATEGORIES]?.label}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* --- ABA 4: AJUSTES & INSTALAÇÃO --- */}
        {currentTab === 'install' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            <header className="mb-6">
              <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                <Settings className="text-primary-500" size={24} /> Configurações & Instalação
              </h2>
              <p className="text-zinc-500 text-sm mt-1">Gerencie sons, vibração e compartilhamento do app.</p>
            </header>

            {/* Configurações de Alarme (Som & Vibração) */}
            <div className="glass p-6 rounded-[2rem] border border-zinc-800 space-y-4 shadow-xl">
              <h3 className="text-sm font-bold uppercase tracking-wider text-primary-400 flex items-center gap-2">
                <Sliders size={16} /> Ajustes de Alarme
              </h3>
              
              <div className="space-y-4">
                {/* Vibração */}
                <div className="flex items-center justify-between py-2 border-b border-zinc-800/40">
                  <div className="space-y-0.5 pr-4">
                    <h4 className="text-sm font-bold text-zinc-200">Vibração ao Disparar</h4>
                    <p className="text-[11px] text-zinc-500">Ativa a vibração (haptics) do celular quando o alarme toca.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setVibrationEnabled(!vibrationEnabled);
                      if (Capacitor.isNativePlatform()) {
                        Haptics.impact({ style: ImpactStyle.Light });
                      }
                    }}
                    className={cn(
                      "w-12 h-6 rounded-full p-1 transition-all duration-200 flex items-center",
                      vibrationEnabled ? "bg-primary-600 justify-end" : "bg-zinc-800 justify-start"
                    )}
                  >
                    <motion.div 
                      layout
                      className="w-4 h-4 bg-white rounded-full shadow"
                    />
                  </button>
                </div>

                {/* Som do Alarme */}
                <div className="flex flex-col gap-3 py-2">
                  <div className="space-y-0.5">
                    <h4 className="text-sm font-bold text-zinc-200">Som do Alarme</h4>
                    <p className="text-[11px] text-zinc-500">Toque em ▶ para ouvir o preview antes de escolher. O alarme toca em loop até você dispensar.</p>
                  </div>

                  {/* Cards de sons pré-definidos */}
                  <div className="flex flex-col gap-2">
                    {ALARM_SOUNDS.map(sound => {
                      const isSelected = selectedAudioUrl === sound.url;
                      const isPreviewing = previewingUrl === sound.url;
                      return (
                        <div
                          key={sound.url}
                          onClick={() => {
                            setSelectedAudioUrl(sound.url);
                            setCustomSoundName('');
                            localStorage.removeItem('silent_custom_sound_name');
                          }}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                            isSelected
                              ? "border-primary-500/50 bg-primary-500/10"
                              : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
                          )}
                        >
                          {/* Indicador de selecionado */}
                          <div className={cn(
                            "w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-all",
                            isSelected ? "border-primary-400 bg-primary-400" : "border-zinc-600"
                          )} />

                          {/* Nome */}
                          <span className={cn(
                            "flex-1 text-xs font-medium",
                            isSelected ? "text-primary-300" : "text-zinc-400"
                          )}>
                            {sound.name}
                          </span>

                          {/* Botão de preview */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isPreviewing) stopPreview();
                              else playPreview(sound.url);
                            }}
                            className={cn(
                              "p-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 flex-shrink-0",
                              isPreviewing
                                ? "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
                            )}
                          >
                            {isPreviewing ? (
                              <><span className="text-base leading-none">⏹</span> Parar</>
                            ) : (
                              <><span className="text-base leading-none">▶</span> Ouvir</>
                            )}
                          </button>
                        </div>
                      );
                    })}

                    {/* Opção: toque personalizado */}
                    <div className={cn(
                      "flex flex-col gap-2 p-3 rounded-xl border transition-all",
                      customSoundName
                        ? "border-primary-500/50 bg-primary-500/10"
                        : "border-zinc-800 bg-zinc-900/50"
                    )}>
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-all",
                          customSoundName ? "border-primary-400 bg-primary-400" : "border-zinc-600"
                        )} />
                        <span className={cn(
                          "flex-1 text-xs font-medium",
                          customSoundName ? "text-primary-300" : "text-zinc-500"
                        )}>
                          {customSoundName ? customSoundName : 'Toque personalizado...'}
                        </span>
                        {customSoundName && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (previewingUrl === selectedAudioUrl) stopPreview();
                              else playPreview(selectedAudioUrl);
                            }}
                            className={cn(
                              "p-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 flex-shrink-0",
                              previewingUrl === selectedAudioUrl
                                ? "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
                            )}
                          >
                            {previewingUrl === selectedAudioUrl ? (
                              <><span className="text-base leading-none">⏹</span> Parar</>
                            ) : (
                              <><span className="text-base leading-none">▶</span> Ouvir</>
                            )}
                          </button>
                        )}
                      </div>
                      <label className="flex items-center justify-center gap-2 py-2 px-3 bg-zinc-800 hover:bg-zinc-700 border border-dashed border-zinc-600 hover:border-primary-500/50 rounded-lg cursor-pointer transition-all text-xs text-zinc-400 hover:text-zinc-200">
                        <span className="text-lg leading-none">📂</span>
                        Escolher arquivo (MP3, OGG, WAV)
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={handleCustomAudioUpload}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Premium Download Box */}
            <div className="glass p-6 rounded-[2rem] border border-primary-500/20 bg-gradient-to-br from-primary-600/15 via-transparent to-transparent space-y-5 text-center relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-primary-500/10 px-4 py-1.5 rounded-bl-2xl text-[9px] font-bold text-primary-400 uppercase tracking-widest">
                Recomendado
              </div>

              <div className="bg-primary-600/10 w-16 h-16 rounded-3xl flex items-center justify-center mx-auto text-primary-400 border border-primary-500/20">
                <Download size={32} className="animate-bounce" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-white">Instalar App no Android</h3>
                <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                  Baixe e instale o aplicativo direto no seu celular para rodar como um app nativo independente, sem precisar deixar o navegador aberto!
                </p>
              </div>

              <div className="flex justify-center pt-2">
                {/* Download Direct APK */}
                <a 
                  href="https://github.com/felipe-spengler/Tarefas-Diarias-App/releases/download/latest/Silencioso-App.apk"
                  download="Silencioso-App.apk"
                  className="px-8 py-3.5 bg-primary-600 hover:bg-primary-500 text-white font-bold rounded-xl text-sm shadow-lg shadow-primary-950/40 transition-all flex items-center justify-center gap-2 active:scale-95 w-full max-w-xs"
                >
                  <Download size={18} /> BAIXAR APK DIRETO
                </a>
              </div>
              
              <p className="text-[10px] text-zinc-500 max-w-xs mx-auto leading-normal">
                Nota: O APK é compilado e atualizado automaticamente pelo GitHub Releases!
              </p>
            </div>

            {/* Sharing Section */}
            <div className="glass p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                <Sparkles size={16} className="text-amber-400" /> Compartilhar com Amigos
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Envie o link do seu site para que seus amigos e familiares possam usar na web ou baixar o APK no celular deles!
              </p>

              <div className="flex items-center gap-2 bg-zinc-950 p-2 rounded-xl border border-zinc-900">
                <input 
                  type="text" 
                  readOnly 
                  value={window.location.origin}
                  className="bg-transparent border-0 p-1 flex-1 text-xs text-zinc-400 font-mono focus:ring-0 focus:border-0"
                />
                <button
                  onClick={copyLinkToClipboard}
                  className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 h-8 min-w-[90px] justify-center"
                >
                  {copied ? (
                    <>
                      <Check size={14} className="text-green-400" /> Copiado!
                    </>
                  ) : (
                    <>
                      <Copy size={14} /> Copiar
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Android Background Configuration Guide */}
            <div className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500 ml-1">Configuração de 2º Plano no Android</h3>
              <div className="space-y-3">
                <div className="glass p-4 rounded-xl border border-zinc-800 flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-primary-400">1</div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-zinc-200">Sem Otimização de Bateria (Crucial)</h4>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Pressione e segure o ícone do app na tela inicial ➔ toque em <strong>Informações do App</strong> ➔ <strong>Bateria</strong> ➔ marque a opção <strong>"Sem Restrições"</strong> (ou "Não Otimizar"). Isso impede o Android de suspender o app.
                    </p>
                  </div>
                </div>

                <div className="glass p-4 rounded-xl border border-zinc-800 flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-primary-400">2</div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-zinc-200">Início Automático (Autostart)</h4>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Em marcas como Xiaomi ou Samsung, nas <strong>Informações do App</strong>, certifique-se de ativar a permissão de <strong>Início Automático</strong> para que ele inicialize junto com o celular se ele for reiniciado.
                    </p>
                  </div>
                </div>

                <div className="glass p-4 rounded-xl border border-zinc-800 flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-primary-400">3</div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-zinc-200">Permissão de Notificações</h4>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Lembre-se de permitir notificações ao abrir o app pela primeira vez. Ele usa notificações e alarmes do Capacitor para chamar sua atenção no momento exato!
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* --- BOTTOM NAVIGATION BAR --- */}
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-900 px-2 pt-3 pb-[calc(env(safe-area-inset-bottom,16px)+12px)] md:pb-4 flex items-center justify-around shadow-2xl">
          <button
            onClick={() => setCurrentTab('tasks')}
            className={cn(
              "flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all",
              currentTab === 'tasks' ? "text-primary-400 font-bold" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Clock size={20} className={currentTab === 'tasks' ? "scale-110 text-primary-500" : ""} />
            <span className="text-[10px] tracking-wider font-semibold">Tarefas</span>
          </button>

          <button
            onClick={() => setCurrentTab('timeline')}
            className={cn(
              "flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all",
              currentTab === 'timeline' ? "text-primary-400 font-bold" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Calendar size={20} className={currentTab === 'timeline' ? "scale-110 text-primary-500" : ""} />
            <span className="text-[10px] tracking-wider font-semibold">Timeline</span>
          </button>

          <button
            onClick={() => setCurrentTab('conditions')}
            className={cn(
              "flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all",
              currentTab === 'conditions' ? "text-primary-400 font-bold" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Sliders size={20} className={currentTab === 'conditions' ? "scale-110 text-primary-500" : ""} />
            <span className="text-[10px] tracking-wider font-semibold">Condições</span>
          </button>

          <button
            onClick={() => setCurrentTab('history')}
            className={cn(
              "flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all",
              currentTab === 'history' ? "text-primary-400 font-bold" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <History size={20} className={currentTab === 'history' ? "scale-110 text-primary-500" : ""} />
            <span className="text-[10px] tracking-wider font-semibold">Histórico</span>
          </button>

          <button
            onClick={() => setCurrentTab('install')}
            className={cn(
              "flex flex-col items-center gap-1 py-1 px-3 rounded-xl transition-all",
              currentTab === 'install' ? "text-primary-400 font-bold" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Settings size={20} className={currentTab === 'install' ? "scale-110 text-primary-500" : ""} />
            <span className="text-[10px] tracking-wider font-semibold">Ajustes</span>
          </button>
        </div>

        {/* Modal/Form */}
        <AnimatePresence>
          {isAdding && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={resetForm}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-md bg-surface border border-zinc-800 rounded-[2rem] shadow-2xl overflow-hidden"
              >
                <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                  <h2 className="text-xl font-bold">{editingTask ? 'Editar Tarefa' : 'Nova Tarefa'}</h2>
                  <button onClick={resetForm} className="p-2 hover:bg-zinc-800 rounded-full">
                    <X size={20} />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                  {/* Tabs */}
                  <div className="flex bg-zinc-900/50 p-1 rounded-xl">
                    <button
                      type="button"
                      onClick={() => setActiveTab('routine')}
                      className={cn(
                        "flex-1 py-2 text-sm font-medium rounded-lg transition-all",
                        activeTab === 'routine' ? "bg-zinc-800 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      Rotina
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('event')}
                      className={cn(
                        "flex-1 py-2 text-sm font-medium rounded-lg transition-all",
                        activeTab === 'event' ? "bg-zinc-800 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      Evento Único
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Título</label>
                    <input 
                      autoFocus
                      placeholder="Ex: Meditação, Reunião..."
                      className="w-full bg-zinc-900/40 border-zinc-800 focus:border-primary-500"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Categoria</label>
                    <div className="grid grid-cols-3 gap-2">
                      {Object.entries(CATEGORIES).map(([key, val]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setCategory(key as Task['category'])}
                          className={cn(
                            "py-2 text-[10px] font-bold rounded-lg border transition-all",
                            category === key ? cn("border-transparent text-white", val.color) : "bg-zinc-900 border-zinc-800 text-zinc-500"
                          )}
                        >
                          {val.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Horário</label>
                      <input 
                        type="time"
                        className="w-full bg-zinc-900/40 border-zinc-800"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Antecedência (m)</label>
                      <input 
                        type="number"
                        min="0"
                        className="w-full bg-zinc-900/40 border-zinc-800"
                        value={advanceMinutes}
                        onChange={(e) => setAdvanceMinutes(parseInt(e.target.value) || 0)}
                      />
                    </div>
                  </div>

                  {activeTab === 'routine' ? (
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Dias da Semana</label>
                      <div className="flex justify-between">
                        {DAYS.map(day => (
                          <button
                            key={day.value}
                            type="button"
                            onClick={() => toggleWeekday(day.value as DayOfWeek)}
                            className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold border transition-all",
                              weekdays.includes(day.value as DayOfWeek) 
                                ? "bg-primary-600 border-primary-500 text-white animate-scale-up" 
                                : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600"
                            )}
                          >
                            {day.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Data</label>
                      <input 
                        type="date"
                        className="w-full bg-zinc-900/40 border-zinc-800"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Condição (Opcional)</label>
                    <select 
                      className="w-full bg-zinc-900/40 border-zinc-800"
                      value={dependencyId}
                      onChange={(e) => setDependencyId(e.target.value)}
                    >
                      <option value="">Nenhuma dependência</option>
                      {tasks.filter(t => t.id !== editingTask?.id).map(t => (
                        <option key={t.id} value={t.id}>Só avisar se "{t.title}" for concluída</option>
                      ))}
                    </select>
                  </div>

                  <button 
                    type="submit"
                    className="w-full py-4 bg-primary-600 hover:bg-primary-500 text-white font-bold rounded-2xl shadow-xl shadow-primary-900/20 transition-all mt-4"
                  >
                    {editingTask ? 'Salvar Alterações' : 'Criar Tarefa'}
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Active Alarm Modal */}
        <AnimatePresence>
          {activeAlarm && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-primary-950/90 backdrop-blur-xl"
              />
              <motion.div 
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                className="relative w-full max-w-sm text-center"
              >
                <div className="mb-8 relative">
                  <div className="absolute inset-0 bg-primary-500/20 blur-3xl rounded-full animate-pulse" />
                  <div className="relative bg-zinc-900 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-primary-500 shadow-2xl shadow-primary-500/40">
                    <Bell size={40} className="text-primary-500 animate-bounce" />
                  </div>
                  <h2 className="text-4xl font-black mb-2">{activeAlarm.title}</h2>
                  <p className="text-primary-400 text-xl font-medium">Inicia às {activeAlarm.time}</p>
                </div>

                <div className="space-y-4 px-6">
                  <button 
                    onClick={() => completeTask(activeAlarm)}
                    className="w-full py-5 bg-white text-black font-black text-xl rounded-2xl shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 size={24} /> CONCLUIR TAREFA
                  </button>
                  <button 
                    onClick={snoozeAlarm}
                    className="w-full py-4 bg-zinc-900 text-zinc-300 font-bold text-lg rounded-2xl border border-zinc-800 active:scale-95 transition-all flex items-center justify-center gap-2"
                  >
                    <Clock size={20} /> SONECA (5 MIN)
                  </button>
                  <button 
                    onClick={() => declineTask(activeAlarm)}
                    className="w-full py-4 bg-red-500/10 border border-red-500/20 text-red-400 font-bold text-lg rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
                  >
                    <X size={20} /> RECUSAR TAREFA
                  </button>
                  <button 
                    onClick={stopAlarm}
                    className="w-full py-2 text-zinc-600 font-medium text-xs hover:text-zinc-400 transition-colors"
                  >
                    Apenas silenciar alarme (sem registrar)
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Permissão de Notificações Modal */}
        <AnimatePresence>
          {showPermissionPrompt && (
            <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/80 backdrop-blur-md"
              />
              <motion.div 
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="relative w-full max-w-sm bg-surface border border-zinc-800 rounded-[2rem] shadow-2xl p-6 text-center space-y-6 overflow-hidden"
              >
                <div className="relative w-20 h-20 rounded-3xl bg-primary-600/10 border border-primary-500/20 flex items-center justify-center mx-auto text-primary-400">
                  <Bell size={36} className="animate-pulse" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-white">Ativar Notificações 🔔</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed px-2">
                    O <strong>Barulhento</strong> precisa de permissão para enviar notificações para que seus alarmes e lembretes toquem no horário exato!
                  </p>
                </div>

                <div className="space-y-3 pt-2">
                  <button
                    onClick={requestPermissions}
                    className="w-full py-4 bg-primary-600 hover:bg-primary-500 text-white font-bold rounded-2xl shadow-xl shadow-primary-950/20 transition-all active:scale-95 text-sm"
                  >
                    ATIVAR NOTIFICAÇÕES
                  </button>
                  
                  <button
                    onClick={() => setShowPermissionPrompt(false)}
                    className="w-full py-2 text-zinc-500 hover:text-zinc-300 text-xs font-semibold transition-colors"
                  >
                    Configurar mais tarde
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
