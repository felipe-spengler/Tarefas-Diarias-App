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
  Settings
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
}

const CATEGORIES = {
  work: { label: 'Trabalho', color: 'bg-blue-500', text: 'text-blue-400' },
  health: { label: 'Saúde', color: 'bg-green-500', text: 'text-green-400' },
  study: { label: 'Estudo', color: 'bg-purple-500', text: 'text-purple-400' },
  personal: { label: 'Pessoal', color: 'bg-orange-500', text: 'text-orange-400' },
  other: { label: 'Outros', color: 'bg-zinc-500', text: 'text-zinc-400' },
};

const DAYS = [
  { label: 'D', value: 0 },
  { label: 'S', value: 1 },
  { label: 'T', value: 2 },
  { label: 'Q', value: 3 },
  { label: 'Q', value: 4 },
  { label: 'S', value: 5 },
  { label: 'S', value: 6 },
];

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const sortedTasks = [...tasks].sort((a, b) => a.time.localeCompare(b.time));
  const [isAdding, setIsAdding] = useState(false);
  const [activeTab, setActiveTab] = useState<'routine' | 'event'>('routine');
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // Global States
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isHolidayMode, setIsHolidayMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Form State
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('12:00');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [weekdays, setWeekdays] = useState<DayOfWeek[]>([]);
  const [advanceMinutes, setAdvanceMinutes] = useState(5);
  const [category, setCategory] = useState<Task['category']>('personal');
  const [dependencyId, setDependencyId] = useState<string>('');

  // Alarm State
  const [activeAlarm, setActiveAlarm] = useState<Task | null>(null);
  const [audio] = useState(new Audio('https://assets.mixkit.co/active_storage/sfx/941/941-preview.mp3'));
  
  useEffect(() => {
    audio.loop = true;
  }, [audio]);

  // --- Persistence ---
  useEffect(() => {
    const savedTasks = localStorage.getItem('silent_tasks');
    const savedHistory = localStorage.getItem('silent_history');
    const savedHoliday = localStorage.getItem('silent_holiday');
    
    if (savedTasks) setTasks(JSON.parse(savedTasks));
    if (savedHistory) setHistory(JSON.parse(savedHistory));
    if (savedHoliday) setIsHolidayMode(JSON.parse(savedHoliday));
  }, []);

  useEffect(() => {
    localStorage.setItem('silent_tasks', JSON.stringify(tasks));
    localStorage.setItem('silent_history', JSON.stringify(history));
    localStorage.setItem('silent_holiday', JSON.stringify(isHolidayMode));
  }, [tasks, history, isHolidayMode]);

  // --- Notification Permission ---
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
    } else if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // --- Background Logic (Every 30s) ---
  const checkNotifications = useCallback(() => {
    const now = new Date();
    const currentDay = now.getDay();
    const currentTimeStr = format(now, 'HH:mm');

    setTasks(prevTasks => {
      let changed = false;
      const updatedTasks = prevTasks.map(task => {
        if (!task.isActive) return task;

        // Skip routines in Holiday Mode
        if (isHolidayMode && task.type === 'routine') return task;

        // Check Snooze
        if (task.snoozedUntil && new Date(task.snoozedUntil) > now) return task;

        // Check Dependency (Task Condition)
        if (task.dependencyId) {
          const wasDependentCompleted = history.some(h => 
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
            if (now >= notificationTime && now < targetToday) {
              const lastDate = task.lastNotifiedAt ? new Date(task.lastNotifiedAt) : null;
              if (!lastDate || !isSameDay(lastDate, now)) {
                shouldNotify = true;
              }
            }
          }
        } else {
          if (task.date && isSameDay(parseISO(task.date), now)) {
            if (now >= notificationTime && now < targetToday) {
              const lastDate = task.lastNotifiedAt ? new Date(task.lastNotifiedAt) : null;
              if (!lastDate || !isSameDay(lastDate, now)) {
                shouldNotify = true;
              }
            }
          }
        }

        if (shouldNotify) {
          sendNotification(task);
          changed = true;
          return { ...task, lastNotifiedAt: now.toISOString(), snoozedUntil: undefined };
        }

        return task;
      });

      return changed ? updatedTasks : prevTasks;
    });
  }, [tasks, history, isHolidayMode]);

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
    const message = `Sua tarefa "${task.title}" inicia em ${task.advanceMinutes} minutos (às ${task.time}).`;
    
    // Trigger Alarm UI and Sound
    setActiveAlarm(task);
    audio.play().catch(e => console.log('Audio blocked until interaction'));

    // Native Capacitor Notifications
    if (Capacitor.isNativePlatform()) {
      Haptics.impact({ style: ImpactStyle.Heavy });
      await LocalNotifications.schedule({
        notifications: [
          {
            title: 'Alarme Silencioso',
            body: message,
            id: Math.floor(Math.random() * 10000),
            schedule: { at: new Date(Date.now() + 100) },
            sound: 'alarm.wav',
            attachments: [],
            extra: null
          }
        ]
      });
    } else {
      // Web Notifications
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Alarme Silencioso', {
          body: message,
          icon: '/vite.svg',
          vibrate: [500, 100, 500, 100, 500],
          requireInteraction: true,
        } as any);
      }
    }
  };

  const stopAlarm = () => {
    audio.pause();
    audio.currentTime = 0;
    setActiveAlarm(null);
  };

  const completeTask = (task: Task) => {
    const newItem: HistoryItem = {
      id: crypto.randomUUID(),
      taskId: task.id,
      title: task.title,
      completedAt: new Date().toISOString(),
      category: task.category,
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
      id: editingTask?.id || crypto.randomUUID(),
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
    setWeekdays([]);
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

  return (
    <div className="min-h-screen bg-background p-4 md:p-8 flex justify-center">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
              Silencioso
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
              onClick={() => setShowHistory(!showHistory)}
              className="p-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 rounded-full transition-all active:scale-95 border border-zinc-800"
              title="Histórico"
            >
              <Settings size={20} />
            </button>
            <button 
              onClick={() => setIsAdding(true)}
              aria-label="Adicionar Tarefa"
              className="p-3 bg-primary-600 hover:bg-primary-500 rounded-full shadow-lg shadow-primary-900/20 transition-all active:scale-95"
            >
              <Plus size={24} />
            </button>
          </div>
        </header>

        {/* History View */}
        <AnimatePresence>
          {showHistory && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-8 overflow-hidden"
            >
              <div className="glass p-6 rounded-2xl">
                <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                  <CheckCircle2 className="text-green-500" size={20} /> Histórico de Conclusão
                </h3>
                <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                  {history.length === 0 ? (
                    <p className="text-zinc-500 text-sm py-4 text-center italic">Nenhuma tarefa concluída recentemente.</p>
                  ) : (
                    history.map(item => (
                      <div key={item.id} className="flex items-center justify-between py-2 border-b border-zinc-800/50">
                        <div>
                          <p className="text-sm font-medium">{item.title}</p>
                          <p className="text-[10px] text-zinc-500">{format(parseISO(item.completedAt), 'dd/MM/yyyy HH:mm')}</p>
                        </div>
                        <div className={cn("w-2 h-2 rounded-full", CATEGORIES[item.category as keyof typeof CATEGORIES]?.color)} />
                      </div>
                    ))
                  )}
                </div>
                <button 
                  onClick={() => setHistory([])}
                  className="w-full mt-4 py-2 text-xs text-zinc-500 hover:text-red-400 transition-colors"
                >
                  Limpar Histórico
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Widget / Dashboard */}
        {sortedTasks.length > 0 && !showHistory && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-6 bg-gradient-to-br from-primary-600/20 to-primary-900/10 border border-primary-500/20 rounded-[2rem] flex items-center justify-between"
          >
            <div>
              <p className="text-primary-400 text-[10px] font-bold uppercase tracking-wider mb-1">Próxima Atividade</p>
              <h2 className="text-2xl font-bold text-white">{sortedTasks.find(t => t.isActive)?.title || 'Nenhuma ativa'}</h2>
              <p className="text-zinc-500 text-sm mt-1 flex items-center gap-1">
                <Clock size={14} /> às {sortedTasks.find(t => t.isActive)?.time || '--:--'}
              </p>
            </div>
            <div className="bg-primary-500 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg shadow-primary-500/20">
              <Bell className="text-white animate-pulse-slow" size={28} />
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
                  className="mt-4 text-primary-500 hover:underline text-sm"
                >
                  Criar minha primeira rotina
                </button>
              </motion.div>
            )}

            {sortedTasks.map((task) => (
              <motion.div
                key={task.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className={cn(
                  "glass p-5 rounded-2xl flex items-center justify-between group transition-all relative overflow-hidden",
                  (!task.isActive || (isHolidayMode && task.type === 'routine')) && "opacity-40 grayscale-[0.5]"
                )}
              >
                {/* Category accent bar */}
                <div className={cn("absolute left-0 top-0 bottom-0 w-1", CATEGORIES[task.category].color)} />

                <div className="flex items-center gap-4">
                  <div className={cn(
                    "p-3 rounded-xl",
                    task.type === 'routine' ? "bg-zinc-800/50 text-zinc-400" : "bg-zinc-800/50 text-zinc-400"
                  )}>
                    {task.type === 'routine' ? <RotateCcw size={20} /> : <Calendar size={20} />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-zinc-100">{task.title}</h3>
                      <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase", CATEGORIES[task.category].color, "bg-opacity-20", CATEGORIES[task.category].text)}>
                        {CATEGORIES[task.category].label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-zinc-500 mt-1">
                      <span className="flex items-center gap-1 font-mono text-zinc-300">
                        <Clock size={12} /> {task.time}
                      </span>
                      {task.type === 'routine' ? (
                        <span className="flex gap-1">
                          {DAYS.map(d => (
                            <span 
                              key={d.value}
                              className={cn(
                                "w-4 h-4 flex items-center justify-center rounded-[2px] text-[9px]",
                                task.weekdays?.includes(d.value as DayOfWeek) ? "bg-zinc-700 text-zinc-300" : "text-zinc-800"
                              )}
                            >
                              {d.label}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 uppercase text-[10px]">
                          <Calendar size={12} /> {task.date && format(parseISO(task.date), 'dd MMM', { locale: ptBR })}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-primary-400">
                        <Bell size={12} /> -{task.advanceMinutes}m
                      </span>
                    </div>
                    {task.dependencyId && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-600 italic">
                        <Settings size={10} /> Depende de outra tarefa
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => toggleTask(task.id)}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      task.isActive ? "text-green-500 hover:bg-green-500/10" : "text-zinc-600 hover:bg-zinc-800"
                    )}
                  >
                    {task.isActive ? <CheckCircle2 size={20} /> : <BellOff size={20} />}
                  </button>
                  <button 
                    onClick={() => startEdit(task)}
                    className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button 
                    onClick={() => deleteTask(task.id)}
                    className="p-2 text-zinc-500 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
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
                      className="w-full"
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
                        className="w-full"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Antecedência (m)</label>
                      <input 
                        type="number"
                        min="0"
                        className="w-full"
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
                                ? "bg-primary-600 border-primary-500 text-white" 
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
                        className="w-full"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-zinc-500 uppercase mb-2 ml-1">Condição (Opcional)</label>
                    <select 
                      className="w-full"
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
                  <div className="absolute inset-0 bg-primary-500/20 blur-3xl rounded-full animate-pulse-slow" />
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
                    onClick={stopAlarm}
                    className="w-full py-2 text-zinc-500 font-medium text-sm hover:text-zinc-300 transition-colors"
                  >
                    Apenas ignorar
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Footer info */}
        <div className="mt-12 text-center pb-12 space-y-4">
          <div className="flex flex-col items-center gap-4">
            <a 
              href="https://github.com/felipe-spengler/Tarefas-Diarias-App/actions" 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-2xl border border-zinc-800 transition-all text-sm font-bold shadow-xl"
            >
              <Download size={18} /> BAIXAR APP (APK)
            </a>
            <p className="text-[10px] text-zinc-600 max-w-[200px] leading-relaxed">
              Clique acima para baixar o APK direto do GitHub (requer login no GitHub).
            </p>
          </div>

          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900/50 rounded-full text-[10px] text-zinc-600 uppercase tracking-widest border border-zinc-800/50">
            <AlertCircle size={12} />
            Verificação a cada 30 segundos
          </div>
        </div>
      </div>
    </div>
  );
}
