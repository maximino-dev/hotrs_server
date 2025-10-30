const express = require('express');
const cors = require('cors');
const db = require('./db');
const axios = require("axios");
const { Party, Member, Track } = require('./party');

const app = express();

const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

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
  socket.on('playerAnswer', ({ partyId, artistTitle }, callback) => {

    let changed = false;
    console.log(`📝 Réponse du joueur ${socket.id} dans ${partyId} : ${artistTitle}`);
    const p = parties.find(p => p.id === partyId);

    try {
      const stats = p.guess(artistTitle);
      console.log(stats);
      if (stats[2] >= 0.8) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, 5);
          p.setMemberFoundArtist(socket.id, true);
          changed = true;
        }
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, 5);
          p.setMemberFoundTitle(socket.id, true);
          changed = true;
        }
          
        if (changed) {
          io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        }

        return callback({ success: true, result: "both" });
      } else if(stats[1] >= 0.6) {
        if (p.memberFoundArtist(socket.id) === false) {
          p.memberAddScore(socket.id, 5);
          p.setMemberFoundArtist(socket.id, true);
          io.to(partyId).emit('partyUpdate', { players: p.getPlayerList() });
        }

        return callback({ success: true, result: "artist" });
      } else if (stats[0] >= 0.6) {
        if (p.memberFoundTitle(socket.id) === false) {
          p.memberAddScore(socket.id, 5);
          p.setMemberFoundTitle(socket.id, true);
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

    // Rejoindre une partie existante
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


/* ======== SERVER ======== */
server.listen(PORT, () => {
  console.log(`✅ API & WebSocket lancés sur http://localhost:${PORT}`);
});
