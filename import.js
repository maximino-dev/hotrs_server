// import.js
const axios = require("axios");
const db = require("./db");
require("dotenv").config();

const APIKEY = process.env.LASTFM_API_KEY;
const BASEURL = "https://ws.audioscrobbler.com/2.0/";

function cleanTitle(title) {
  return title
    .replace(/\(.*?\)/g, "")       // Supprime tout ce qui est entre parenthèses
    .replace(/\[.*?\]/g, "")       // Supprime tout ce qui est entre crochets
    .replace(/- .*version/i, "")   // Supprime les versions types "Remastered" ou autres
    .replace(/remaster(ed)?/i, "") // Supprime les mots "Remaster", "Remastered"
    .replace(/Remaster(ed)?/i, "") 
    .replace(/live/i, "")          // Supprime "Live"
    .replace(/\s{2,}/g, " ")       // Réduit les espaces multiples
    .split(" - ")[0]               // Enleve tout ce qui est apres un -
    .trim();                       // Enlève les espaces de début et fin
}

async function searchDeezer(title, artist) {
  const query = encodeURIComponent(`${title} ${artist}`);
  const url = `https://api.deezer.com/search?q=${query}`;

  try {
    const res = await axios.get(url);

    const track = res.data.data[0];

    if (!track || !track.album || !track.album.id) {
      throw new Error("Aucun résultat ou album non trouvé");
    }

    const albumId = track.album.id;
    const albumRes = await axios.get(`https://api.deezer.com/album/${albumId}`);

    const releaseDate = albumRes.data.release_date || null;
    const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4)) : null;
    return {
      title: track.title,
      artist: track.artist.name,
      preview: track.preview,
      cover_url: track.album.cover_medium,
      deezer_id: track.id,
      year: releaseYear
    };
  } catch (e) {
    console.error("Erreur recherche Deezer:", e.message);
    return null;
  }
}

function formatGenres(genres = []) {
  const output = new Array(5).fill(null);
  for (let i = 0; i < Math.min(5, genres.length); i++) {
    output[i] = genres[i];
  }
  return output;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function importFromLastFm(tag = "pop", limit = 1) {
  const lastFmUrl = `${BASEURL}?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&api_key=${APIKEY}&format=json&limit=${limit}`;

  try {
    const res = await axios.get(lastFmUrl);
    const tracks = res.data.tracks.track;

    for (const track of tracks) {
      const title = track.name;
      const artist = track.artist.name;

      const deezerTrack = await searchDeezer(title, artist);

      if (deezerTrack?.preview && deezerTrack?.year) {
        importTrack(title, artist, tag);
      } else {
        console.log(`❌ Pas d'extrait pour : ${title} - ${artist}`);
      }
      await delay(500); // 500ms entre chaque requête
    }
  } catch (e) {
    console.error("Erreur Last.fm:", e.message);
  }
}

async function importTrack(title, artist, genre = "") {

  const deezerTrack = await searchDeezer(title, artist);

  if (deezerTrack?.preview && deezerTrack?.year) {
    const query = `
      INSERT INTO tracks (title, artist, genre0, genre1, genre2, genre3, genre4, year, cover_url, deezer_id, popularity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING
    `;

    const datas = await getGenreAndPopularity(title, artist);

    if (!datas || !datas.genres || !Array.isArray(datas.genres) || (!datas.genres[0] && !genre) ) {
      console.log(`❌ Pas de données Last.fm pour : ${title} - ${artist}`);
      return;
    }

    const genres = formatGenres(datas.genres);

    if (!genres[0]) {
      genres[0] = genre;
    }

    const popularity = calculatePopularityScore(datas.popularity.playcount, datas.popularity.playcount);

    const values = [
      cleanTitle(title),
      artist,
      genres[0],
      genres[1],
      genres[2],
      genres[3],
      genres[4],
      deezerTrack.year,
      deezerTrack.cover_url || "",
      deezerTrack.deezer_id,
      popularity
    ];

    const res = await db.query(query, values);

    if (res.rowCount == 0) {
      console.log(`${title} - ${artist} déjà présent en base`);
    } else {
      console.log(`✅ Importé : ${title} - ${artist}`);
    }
  } else {
    console.log(`❌ Pas d'extrait pour : ${title} - ${artist}`);
  }
}

function calculatePopularityScore(playcount, listeners) {
  // Convertir les valeurs en nombres entiers
  playcount = parseInt(playcount);
  listeners = parseInt(listeners);

  // Calcul d'un score basé sur le logarithme (évite les trop gros écarts)
  const logPlaycount = Math.log10(playcount + 1); // +1 pour éviter log(0)
  const logListeners = Math.log10(listeners + 1);

  // Score combiné, tu peux ajuster les poids
  const rawScore = (logPlaycount * 0.7) + (logListeners * 0.3);

  // Normalisation du score entre 1 et 100
  // log(1 milliard) ~ 9, donc on suppose que 10 est le maximum
  const normalizedScore = Math.min(100, Math.round((rawScore / 10) * 100));

  return normalizedScore;
}

async function getGenreAndPopularity(title, artist) {
  const url = `${BASEURL}?method=track.getInfo&api_key=${APIKEY}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&format=json`;

  try {
    const res = await axios.get(url);
    const track = res.data.track;

    const genres = track.toptags?.tag?.map(tag => tag.name.toLowerCase()) || [];
    const playcount = parseInt(track.playcount || 0, 10);
    const listeners = parseInt(track.listeners || 0, 10);

    return {
      title: cleanTitle(track.name),
      artist: track.artist.name,
      genres,
      popularity: {
        playcount,
        listeners,
      }
    };
  } catch (e) {
    console.error(`❌ Erreur récupération Last.fm : ${e.message}`);
    return null;
  }
}
/*
importTrack("love will tear us apart", "Joy division", "").then(() => {
  console.log("✅ Fin de l'import.");
  process.exit();
});
*/

importFromLastFm("new wave", 20).then(() => {
  console.log("✅ Fin de l'import.");
  process.exit();
});