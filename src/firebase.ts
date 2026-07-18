import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  increment,
  runTransaction,
  query,
  where,
  getDocs,
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyArIHbKzWw9XcrQKGJZgZV5F0olZcVNiuI',
  authDomain: 'npat-game-f7b4f.firebaseapp.com',
  projectId: 'npat-game-f7b4f',
  storageBucket: 'npat-game-f7b4f.firebasestorage.app',
  messagingSenderId: '561709172554',
  appId: '1:561709172554:web:fb737e1d187c9d6214a3b3',
  measurementId: 'G-LTL7304EDK',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export {
  app,
  db,
  auth,
  signInAnonymously,
  onAuthStateChanged,
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  increment,
  runTransaction,
  query,
  where,
  getDocs,
};
