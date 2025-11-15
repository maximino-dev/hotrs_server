const express = require('express');
const cors = require('cors');
const db = require('./db');
const axios = require("axios");
const { Party, Member, Track } = require('./party');
const path = require('path');

const app = express();

const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

app.use('/solos', express.static(path.join(__dirname, 'solos'), {
  index: false
}));

// Configuration CORS pour Socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3001;

var parties = [];


/* ======== SOCKET.IO ======== */
io.on('connection', (socket) => {
  console.log(`✅ Nouvelle connexion : ${socket.id}`);

  // Création d'une partie
  socket.on('createParty', async ({ username, options }, callback) => {
    const partyId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const newParty = new Party(partyId, options.genre, options.yearMin, options.yearMax, options.limit, options.difficulty);
    const creator = new Member(socket.id, username);

    newParty.join(creator);
    parties.push(newParty);
    socket.join(partyId);

    // Appel de prépare le blind test avec les options
    try {
      const prepResult = await prepareBlindTest(newParty);
      if (prepResult.code !== 0) {
        // Échec préparation
        parties = parties.filter(p => p.id !== partyId);
        callback({ success: false, message: prepResult.error || 'Erreur lors de la préparation du Blind Test'});
        return;
      }

      // Préparation réussie, envoie les infos de la partie
      console.log(`🎉 Partie créée : ${partyId} par ${username}`);
      io.to(partyId).emit('partyUpdate', { players: newParty.getPlayerList() });
      callback({ success: true, partyId: partyId });

    } catch (err) {
      console.error('Erreur dans createParty / prepareBlindTest :', err);
      callback({ success: false, message: 'Erreur serveur inattendue'});
      parties = parties.filter(p => p.id !== partyId);
    }

  });

  // Rejoindre une partie existante
  socket.on('joinParty', async ({ partyId, username }, callback) => {
    const p = parties.find(p => p.id === partyId);
    if (!p) {
      return callback({ success: false, message: 'Partie introuvable' });
    }

    if (p.memberExists(username)) {
      return callback({ success: false, message: 'Pseudo déjà présent dans la partie' });      
    }

    const member = new Member(socket.id, username);
    p.join(member);
    socket.join(partyId);

    console.log(`👤 ${username} a rejoint la partie ${partyId}`);
    io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });

    if (p.started) {
      const track = p.getCurrentTrack();
      if (track) {
        const preview = await searchDeezerPreview(track.deezerId);
        socket.emit('playTrack', { preview_link: preview });
      }
    }

    return callback({ success: true });
  });

  // Lancement de la partie
  socket.on('startParty', async ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);

    if (p == null) {
      return;
    }

    if (p.getStarted()) {
      return;
    }

    try {
      p.start();
      const track = p.getCurrentTrack();
      const preview = await searchDeezerPreview(track.deezerId);
      io.to(partyId).emit('playTrack', { preview_link: preview });
      console.log("Lancement de la partie:", p.tracks);
    } catch (err) {
      console.error('Erreur dans startParty :', err);
    }
  });

  // Changement de musique
  socket.on('nextTrack', async ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);

    try {
      const track = p.getNextTrack();
      p.resetFound();
      if (typeof track === 'undefined') {
        io.to(partyId).emit('finishParty');
        p.stop();
        await prepareBlindTest(p);
      } else {
        const preview = await searchDeezerPreview(track.deezerId);
        io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        io.to(partyId).emit('playTrack', { preview_link: preview });
      }
    } catch (err) {
      console.error('Erreur dans startParty :', err);
    }

  });

  // Changement de musique
  socket.on('nextTrackSolomode', async ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);

    try {
      const track = p.getNextTrack();
      p.resetFound();
      if (typeof track === 'undefined') {
        const player = p.getPlayerList()[0];
        await addToLeaderboard(player.username, player.score, "solo");
        p.stop();
        await prepareSoloMode(p);
        socket.emit('finishParty');
      } else {
        socket.emit('playTrack', { song_id: track.deezerId, duration: track.duration });
      }
    } catch (err) {
      console.error('Erreur dans startParty :', err);
    }

  });

  socket.on('startSolomode', async ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);


    try {
      const track = p.getCurrentTrack();
      socket.emit('playTrack', { song_id: track.deezerId, duration: track.duration });
    } catch (err) {
      console.error('Erreur dans startParty :', err);
    }

  });

  socket.on('getCurrentTrack', ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);

    try {
      const track = p.getCurrentTrack();
      io.to(partyId).emit('getTrackInfos', { title: track.title, artist: track.artist, coverUrl: track.coverUrl });
    } catch (err) {
      console.error('Erreur dans getCurrentTrack :', err);      
    }
  });
  

  // Réception d'une réponse à une question
  socket.on('playerAnswer', ({ partyId, artistTitle, time }, callback) => {

    let changed = false;
    console.log(`📝 Réponse du joueur ${socket.id} dans ${partyId} : ${artistTitle}`);
    const p = parties.find(p => p.id === partyId);

    const maxScorePerTrack = 100;
    const maxTime = 30000; // 30 sec

    const clampedTime = Math.min(Math.max(time, 0), maxTime);
    const t = clampedTime / maxTime;
    const k = 3; // contrôle la décroissance exponentielle
    const multiplier = Math.exp(-k * t);

    const addScore = (base) => Math.round(base * multiplier);

    try {
      const stats = p.guess(artistTitle);
      console.log(stats);
      if (stats[2] >= 0.8) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundArtist(socket.id, true);
          p.setMemberTimeArtist(socket.id, time);
          changed = true;
        }
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundTitle(socket.id, true);
          p.setMemberTimeTitle(socket.id, time);
          changed = true;
        }
          
        if (changed) {
          io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        }

        return callback({ success: true, result: "both" });
      } else if(stats[1] >= 0.6) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundArtist(socket.id, true);
          p.setMemberTimeArtist(socket.id, time);
          io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        }

        return callback({ success: true, result: "artist" });
      } else if (stats[0] >= 0.6) {
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundTitle(socket.id, true);
          p.setMemberTimeTitle(socket.id, time);
          io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        }

        return callback({ success: true, result: "title" });
      }
      return callback({ success: false });
    } catch (err) {
      return callback({ success: false });
    }
  });

  socket.on("startTrack", ({ partyId, preview_link }) => {
    // Diffuser la chanson à tous les joueurs
    io.to(partyId).emit("playTrack", { preview_link });
  });

  socket.on('restartParty', ({ partyId }) => {
    const p = parties.find(p => p.id === partyId);
    if (p) {
      io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
      io.to(partyId).emit('restartParty');
    }
  });

  // Déconnexion
  socket.on('disconnect', () => {
    for (let p of parties) {
      const wasInParty = p.members.some(m => m.id === socket.id);
      if (wasInParty) {
        p.leave(socket.id);
        io.to(p.id).emit('partyUpdate', { players: p.getPlayerList() });
        console.log(`${socket.id} a quitté la partie ${p.id}`);
        if (p.getPlayerList().length === 0) {
          console.log("Partie ", p.id, " supprimee");
          parties = parties.filter(party => party.id !== p.id);
        }
      }
    }
  });

  socket.on('chatMessage', ({ partyId, username, message }) => {
    console.log(`💬 Message de ${username} dans ${partyId} : ${message}`);

    // On diffuse le message à tous les membres de la partie
    io.to(partyId).emit('chatMessage', {
      username,
      message,
      timestamp: Date.now()
    });
  });

  // Creation d'un mode solo
  socket.on('joinSoloMode', async ({ username }, callback) => {
    const partyId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const newParty = new Party(partyId, null, null, null, 10, null);
    const creator = new Member(socket.id, username);

    newParty.join(creator);
    parties.push(newParty);
    socket.join(partyId);

    // Appel de prépare mode solo
    try {
      const prepResult = await prepareSoloMode(newParty);
      if (prepResult.code !== 0) {
        // Échec préparation
        parties = parties.filter(p => p.id !== partyId);
        callback({ success: false, message: prepResult.error || 'Erreur lors de la préparation du Blind Test'});
        return;
      }

      // Préparation réussie, envoie les infos de la partie
      console.log(`🎉 Partie créée : ${partyId} par ${username}`);

      const track = newParty.getCurrentTrack();
      socket.emit('playTrack', { song_id: track.deezerId, duration: track.duration });

      callback({ success: true, partyId: partyId });

    } catch (err) {
      console.error('Erreur dans createParty / prepareBlindTest :', err);
      callback({ success: false, message: 'Erreur serveur inattendue'});
      parties = parties.filter(p => p.id !== partyId);
    }

  });

  // Answer in a solo Mode (time is in milliseconds)
  socket.on('playerSoloAnswer', ({ partyId, artistTitle, time }, callback) => {

    console.log(`📝 Réponse du joueur ${socket.id} dans ${partyId} (mode solo) : ${artistTitle}`);
    const p = parties.find(p => p.id === partyId);

    const maxScorePerTrack = 100;
    const maxTime = 30000; // 30 sec

    const clampedTime = Math.min(Math.max(time, 0), maxTime);
    const t = clampedTime / maxTime;
    const k = 3; // contrôle la décroissance exponentielle
    const multiplier = Math.exp(-k * t);

    const addScore = (base) => Math.round(base * multiplier);

    try {
      const stats = p.guess(artistTitle);
      console.log(stats);
      if (stats[2] >= 0.8) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundArtist(socket.id, true);
        }
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundTitle(socket.id, true);
        }

        return callback({ success: true, result: "both", score: p.memberGetScore(socket.id) });
      } else if(stats[1] >= 0.6) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundArtist(socket.id, true);
        }

        return callback({ success: true, result: "artist", score: p.memberGetScore(socket.id) });
      } else if (stats[0] >= 0.6) {
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, addScore(maxScorePerTrack));
          p.setMemberFoundTitle(socket.id, true);
        }

        return callback({ success: true, result: "title", score: p.memberGetScore(socket.id) });
      }
      return callback({ success: false });
    } catch (err) {
      return callback({ success: false });
    }
  });

  socket.on('getLeaderboard', async ({ mode }, callback) => {
    try {
      if (mode === "solo") {
        const lb = await getDBLeaderboard(10);
        return callback({ success: true, leaderboard: lb })
      } else {
        return callback({ success: false });
      }
    } catch (err) {
      return callback({ success: false });
    }
  });

});

// <=================== Fin Socket.io



app.use(cors());
app.use(express.json());

/**
 * Endpoint GET /genres
 * Permet de récupérer la liste des genres presents en base.
 * 
 * Reponse: genres : liste
 */
app.get('/api/genres', async (req, res) => {
  let query = "SELECT genre0 FROM tracks GROUP BY genre0";

  try {
    const result = await db.query(query);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Aucun genre trouvé.' });
    }

    const genres = result.rows.map(row => row.genre0);

    return res.status(200).json(genres);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ======== UTILS ======== */

async function searchDeezerPreview(deezerId) {
  const albumId = 0;
  const url = `https://api.deezer.com/track/${deezerId}`;

  try {
    const res = await axios.get(url);

    const track = res.data;

    if (!track || !track.preview) {
      throw new Error("Aucun résultat trouvé");
    }

    return track.preview;
  } catch (e) {
    console.error("Erreur recherche Deezer:", e.message);
    return null;
  }
}

async function prepareBlindTest(party) {
  let limit = party.nbTracks;
  let genre = party.genre;
  let yearMax = party.yearMax;
  let yearMin = party.yearMin;
  const level = party.difficulty?.toLowerCase();

  if (isNaN(limit) || limit < 1) {
    limit = 1;
  }
  if (limit > 50) {
    limit = 50;
  }

  let query = `SELECT * FROM tracks`;
  const conditions = [];
  const values = [];

  // 🔍 Filtrage par genre sur genre0 à genre4
  if (genre && genre !== '') {
    values.push(genre);
    const genreConditions = [
      `genre0 = $${values.length}`,
      `genre1 = $${values.length}`,
      `genre2 = $${values.length}`,
      `genre3 = $${values.length}`,
      `genre4 = $${values.length}`
    ];
    conditions.push(`(${genreConditions.join(' OR ')})`);
  }

  if (yearMin) {
    values.push(parseInt(yearMin));
    conditions.push(`year >= $${values.length}`);
  }

  if (yearMax) {
    values.push(parseInt(yearMax));
    conditions.push(`year <= $${values.length}`);
  }

  // Popularité / niveau
  if (level === 'facile') {
    conditions.push(`popularity >= 70`);
  } else if (level === 'moyen') {
    conditions.push(`popularity >= 60 AND popularity < 70`);
  } else if (level === 'difficile') {
    conditions.push(`popularity < 60`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(' AND ');
  }

  query += ` ORDER BY RANDOM() LIMIT $${values.length + 1}`;
  values.push(limit);

  try {
    const result = await db.query(query, values);
    if (result.rows.length === 0) {
      return ({ code: 1, error: 'Aucun morceau trouvé.' });
    }

    for (const row of result.rows) {
      const track = new Track(row.deezer_id, row.title, row.artist, row.cover_url);
      party.addTrack(track);
    }

    return ({ code: 0 });
  } catch (err) {
    console.error(err);
    return ({ code: 1, error: 'Erreur serveur' });
  }
}

async function prepareSoloMode(party) {

  let query = `SELECT * FROM solos`;

  query += ` ORDER BY RANDOM() LIMIT 10`;

  try {
    const result = await db.query(query);
    if (result.rows.length === 0) {
      return ({ code: 1, error: 'Aucun morceau trouvé.' });
    }

    for (const row of result.rows) {
      const track = new Track(row.filename, row.title, row.artist, row.cover_url, row.duration);
      party.addTrack(track);
    }

    return ({ code: 0 });
  } catch (err) {
    console.error(err);
    return ({ code: 1, error: 'Erreur serveur' });
  }
}

async function getDBLeaderboard(limit = 10) {

  let query = `SELECT * FROM leaderboard`;

  const values = [];
  const ldboard = [];

  query += ` ORDER BY score DESC LIMIT $${values.length + 1}`;
  values.push(limit);

  try {
    const result = await db.query(query, values);
    if (result.rows.length === 0) {
      return ({ code: 1, error: 'Aucun score trouvé.' });
    }

    for (const row of result.rows) {
      ldboard.push({ username: row.username, score: row.score });
    }

    return ldboard;
  } catch (err) {
    console.error(err);
    return 1;
  }
}

async function addToLeaderboard(username, score, mode = "solo") {
  try {
    // Vérifier si le joueur existe déjà
    const check = await db.query(
      `SELECT score FROM leaderboard WHERE username = $1`,
      [username]
    );

    if (check.rows.length > 0) {
      const currentScore = check.rows[0].score;

      // Mettre à jour uniquement si le nouveau score est supérieur
      if (score > currentScore) {
        await db.query(
          `UPDATE leaderboard SET score = $1 WHERE username = $2`,
          [score, username]
        );
      }

      return { success: true, updated: true };
    } else {
      await db.query(
        `INSERT INTO leaderboard (username, score, mode) VALUES ($1, $2, $3)`,
        [username, score, mode]
      );
    }

    // Suppression pour en garder maximum 100
    await db.query(`
      DELETE FROM leaderboard
      WHERE username NOT IN (
        SELECT username FROM leaderboard
        ORDER BY score DESC
        LIMIT 100
      )
    `);

    return { success: true, created: true };
  } catch (err) {
    console.error("Erreur addToLeaderboard:", err);
    return { success: false, error: err.message };
  }
}



/* ======== SERVER ======== */
server.listen(PORT, () => {
  console.log(`✅ API & WebSocket lancés sur http://localhost:${PORT}`);
});
