require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;

// Firebase Admin Setup
let db;
try {
  const serviceAccount = require('./config/serviceAccountKey.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  db = admin.firestore();
  console.log("🔥 Firebase Admin Initialized Successfully");
} catch (error) {
  console.error("⚠️ Firebase Admin Init Failed - Using Mock Mode:", error.message);
  db = {
    collection: () => ({
      doc: () => ({ 
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async () => ({}),
        update: async () => ({}),
        add: async () => ({})
      }),
      where: () => ({ get: async () => ({ size: 0 }) }),
      orderBy: () => ({ get: async () => ({ docs: [] }) })
    })
  };
}

// Middleware
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ message: "Access Denied" });

  jwt.verify(token, process.env.JWT_SECRET || 'techmasters_secret_key', (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid Token" });
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: "Admin Access Required" });
  next();
};

// Routes
app.get('/', (req, res) => {
  res.send('TechMasters Assessment Portal API Running');
});

// Auth Route (User Sync)
app.post('/api/auth/sync', async (req, res) => {
  const { uid, email, name, role } = req.body;
  try {
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    
    let userData = { uid, email, name, role: role || 'student' };
    
    if (!doc.exists) {
      await userRef.set(userData);
    } else {
      userData = doc.data();
    }

    const token = jwt.sign(
      { uid: userData.uid, email: userData.email, role: userData.role },
      process.env.JWT_SECRET || 'techmasters_secret_key',
      { expiresIn: '24h' }
    );

    res.json({ token, user: userData });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Answers Endpoints - Individual save
app.post('/api/answers/save', authenticateToken, async (req, res) => {
  const { questionId, selectedOption, sectionId } = req.body;
  try {
    const answerRef = db.collection('answers').doc(`${req.user.uid}_${questionId}`);
    await answerRef.set({
      studentId: req.user.uid,
      questionId,
      sectionId,
      selectedOption,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Results Endpoints - Final Calculation
app.post('/api/results/submit', authenticateToken, async (req, res) => {
  const { sectionScores, totalScore, percentage } = req.body;
  try {
    // Basic Pass/Fail check (e.g. 60%)
    const status = percentage >= 60 ? 'PASS' : 'FAIL';
    
    const resultData = {
      studentId: req.user.uid,
      studentName: req.user.name || 'Student',
      studentEmail: req.user.email,
      sectionScores,
      totalScore,
      percentage,
      status,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('results').doc(req.user.uid).set(resultData);
    
    // Check rank (simplified: count how many have higher percentage)
    const higherScores = await db.collection('results').where('percentage', '>', percentage).get();
    const rank = higherScores.size + 1;
    
    await db.collection('results').doc(req.user.uid).update({ rank });

    res.json({ message: "Assessment submitted", rank, status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Student Result
app.get('/api/results/my-result', authenticateToken, async (req, res) => {
  try {
    const doc = await db.collection('results').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ message: "Result not found" });
    res.json(doc.data());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Violation Logging
app.post('/api/violations', authenticateToken, async (req, res) => {
  const { violationType, details } = req.body;
  try {
    await db.collection('violations').add({
      studentId: req.user.uid,
      studentEmail: req.user.email,
      violationType,
      details,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Lock account if necessary
    await db.collection('users').doc(req.user.uid).update({
      status: 'locked',
      lockReason: 'Malpractice detected: ' + violationType
    });

    res.json({ message: "Violation logged and account locked" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Admin: Get All Results
app.get('/api/admin/results', authenticateToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('results').orderBy('timestamp', 'desc').get();
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
