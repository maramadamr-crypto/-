import { InteractiveQuiz } from '../types';
import {
  auth,
  saveQuizToFirestore,
  deleteQuizFromFirestore,
  recordQuizAttemptInFirestore,
} from './firebase';

const STORAGE_KEYS = {
  QUIZZES: 'qalami_quizzes_store_v1',
  COMPLETED_QUIZZES: 'qalami_completed_quizzes_v1',
};

// Initial quizzes list must be completely EMPTY per user request!
let inMemoryQuizzes: InteractiveQuiz[] = [];

if (typeof window !== 'undefined') {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.QUIZZES);
    if (raw) {
      inMemoryQuizzes = JSON.parse(raw);
    }
  } catch (e) {
    console.warn('Could not read quizzes from storage', e);
  }
}

type QuizListener = (quizzes: InteractiveQuiz[]) => void;
const listeners: QuizListener[] = [];

function notifyListeners() {
  const current = [...inMemoryQuizzes];
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      console.warn('Quiz listener error', e);
    }
  });
}

export const QuizService = {
  subscribe(listener: QuizListener): () => void {
    listeners.push(listener);
    listener([...inMemoryQuizzes]);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },

  getAllQuizzes(): InteractiveQuiz[] {
    return [...inMemoryQuizzes];
  },

  getQuizzesByAuthor(authorOrUserId: string): InteractiveQuiz[] {
    const term = authorOrUserId.trim().toLowerCase();
    return inMemoryQuizzes.filter(
      (q) => q.userId === authorOrUserId || q.author.trim().toLowerCase() === term
    );
  },

  saveQuiz(quizData: InteractiveQuiz): InteractiveQuiz {
    const existingIndex = inMemoryQuizzes.findIndex((q) => q.id === quizData.id);
    if (existingIndex >= 0) {
      inMemoryQuizzes[existingIndex] = quizData;
    } else {
      inMemoryQuizzes.unshift(quizData);
    }

    try {
      localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
    } catch {
      // ignore
    }

    notifyListeners();

    // Persist to Firebase Firestore
    saveQuizToFirestore(quizData).catch(() => {});

    // Asynchronously sync with Cloud SQL PostgreSQL backend
    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch('/api/quizzes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: quizData.id,
            userId: quizData.userId,
            author: quizData.author,
            title: quizData.title,
            grade: quizData.grade,
            durationMode: quizData.durationMode,
            expireDate: quizData.expireDate,
            totalQuestions: quizData.totalQuestions,
            questionsJson: JSON.stringify(quizData.questions),
            subject: quizData.subject,
            attemptsCount: quizData.attemptsCount || 0,
          }),
        }).catch((err) => console.warn('PostgreSQL quiz sync note:', err));
      }).catch(() => {});
    }

    return quizData;
  },

  deleteQuiz(quizId: string): void {
    inMemoryQuizzes = inMemoryQuizzes.filter((q) => q.id !== quizId);
    try {
      localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
    } catch {
      // ignore
    }
    notifyListeners();

    deleteQuizFromFirestore(quizId).catch(() => {});

    if (auth.currentUser) {
      auth.currentUser.getIdToken().then((token) => {
        fetch(`/api/quizzes/${quizId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch((err) => console.warn('PostgreSQL quiz delete note:', err));
      }).catch(() => {});
    }
  },

  clearAllQuizzes(): void {
    inMemoryQuizzes = [];
    try {
      localStorage.removeItem(STORAGE_KEYS.QUIZZES);
    } catch {
      // ignore
    }
    notifyListeners();
  },

  recordAttempt(quizId: string): void {
    const q = inMemoryQuizzes.find((item) => item.id === quizId);
    if (q) {
      q.attemptsCount = (q.attemptsCount || 0) + 1;
      try {
        localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
      } catch {
        // ignore
      }
      notifyListeners();
      recordQuizAttemptInFirestore(quizId, q.attemptsCount).catch(() => {});
    }
  },

  mergeCloudQuizzes(cloudQuizzes: InteractiveQuiz[]): void {
    if (!Array.isArray(cloudQuizzes) || cloudQuizzes.length === 0) return;
    let changed = false;

    for (const remote of cloudQuizzes) {
      if (!remote?.id) continue;
      const idx = inMemoryQuizzes.findIndex((q) => q.id === remote.id);
      if (idx >= 0) {
        const local = inMemoryQuizzes[idx];
        if ((remote.attemptsCount || 0) > (local.attemptsCount || 0)) {
          inMemoryQuizzes[idx] = { ...local, ...remote };
          changed = true;
        }
      } else {
        inMemoryQuizzes.push(remote);
        changed = true;
      }
    }

    if (changed) {
      try {
        localStorage.setItem(STORAGE_KEYS.QUIZZES, JSON.stringify(inMemoryQuizzes));
      } catch {
        // ignore
      }
      notifyListeners();
    }
  },

  syncLocalQuizzesToFirestore(): void {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    for (const q of inMemoryQuizzes) {
      if (!q.userId || q.userId === 'guest_user' || q.userId === uid) {
        if (!q.userId || q.userId === 'guest_user') {
          q.userId = uid;
        }
        saveQuizToFirestore(q).catch(() => {});
      }
    }
  },
};
