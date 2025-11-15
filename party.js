class Track {
	constructor(deezerId, title, artist, coverUrl, duration = 0) {
		this.deezerId = deezerId;
		this.title = title;
		this.artist = artist;
		this.coverUrl = coverUrl;
		this.duration = duration;
  }
}

class Member {
  constructor(socketId, username = null) {
		this.id = socketId;
		this.username = username;
		this.score = 0;
		this.foundTitle = false;
		this.foundArtist = false;
		this.timeArtist = 0;
		this.timeTitle = 0;
  }
}

class Party {
	constructor(id, genre, yearMin, yearMax, limit, difficulty) {
		this.id = id;
		this.members = [];
		this.currentTrack = 0; // indice du Morceau en cours
		this.started = false;     // La partie a-t-elle commencé ?
		this.genre = genre;
		this.yearMin = yearMin;
		this.yearMax = yearMax;
		this.nbTracks = limit;
		this.difficulty = difficulty;
		this.tracks = [];
	}

	join(member) {
		// Évite les doublons
		const alreadyJoined = this.members.find(m => m.id === member.id);
		if (!alreadyJoined) {
		  this.members.push(member);
		}
	}

	leave(socketId) {
		this.members = this.members.filter(m => m.id !== socketId);
	}

	getPlayerList() {
		return this.members.map(m => ({ id: m.id, 
			username: m.username, 
			score: m.score, 
			foundTitle: m.foundTitle, 
			foundArtist: m.foundArtist, 
			timeArtist: (m.timeArtist / 1000).toFixed(2), 
			timeTitle: (m.timeTitle / 1000).toFixed(2) }));
	}

	memberGetScore(socketId) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			return member.score;
		}
		return false;
	}

	memberExists(username) {
		const member = this.members.find(m => m.username === username);
		if (member) {
			return true;
		}
		return false;
	}

	memberAddScore(socketId, score) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			member.score = member.score + score;
			return true;
		}
		return false;
	}

	memberFoundTitle(socketId) {
		const member = this.members.find(m => m.id === socketId);
		if (member && member.foundTitle) {
			return true;
		}
		return false;
	}

	memberFoundArtist(socketId) {
		const member = this.members.find(m => m.id === socketId);
		if (member && member.foundArtist) {
			return true;
		}
		return false;
	}
	
	setMemberFoundTitle(socketId, val) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			member.foundTitle = val;
			return true;
		}
		return false;
	}

	setMemberFoundArtist(socketId, val) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			member.foundArtist = val;
			return true;
		}
		return false;
	}

	setMemberTimeTitle(socketId, time) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			member.timeTitle = time;
			return true;
		}
		return false;
	}

	setMemberTimeArtist(socketId, time) {
		const member = this.members.find(m => m.id === socketId);
		if (member) {
			member.timeArtist = time;
			return true;
		}
		return false;
	}

	resetFound() {
		this.members.forEach((member, index) => {
  		this.members[index].foundTitle = false;
  		this.members[index].foundArtist = false;
		});
	}

	resetScores() {
		this.members.forEach((member, index) => {
  		this.members[index].score = 0;
		});
	}

	addTrack(track) {
		this.tracks.push(track);
	}

	start() {
		this.started = true;
	}

	stop() {
		this.started = false;
		this.currentTrack = 0;
		this.tracks = [];
		this.resetScores();
	}

	getStarted() {
		return this.started;
	}

	getCurrentTrack() {
		return this.tracks[this.currentTrack];
	}

	getNextTrack() {
		if (this.currentTrack < this.nbTracks) {
			this.currentTrack++;
			return this.tracks[this.currentTrack];
		}
	}

	guess(answer) {
		const title = this.tracks[this.currentTrack].title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
		const artist = this.tracks[this.currentTrack].artist.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

		let values = [];

		const answerFmt = answer.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

		values.push(Party.jaccardSimilarityBigrams(answerFmt, title));
		values.push(Party.jaccardSimilarityBigrams(answerFmt, artist));
		values.push(Party.jaccardSimilarityBigrams(answerFmt, title + " " + artist));
		return values;
	}

	static getBigrams(str) {
		const bigrams = [];
		for (let i = 0; i < str.length - 1; i++) {
			bigrams.push(str.slice(i, i + 2));
		}
		return new Set(bigrams);
	}

	static jaccardSimilarityBigrams(str1, str2) {
		const bigrams1 = Party.getBigrams(str1);
		const bigrams2 = Party.getBigrams(str2);

		const intersection = new Set([...bigrams1].filter(b => bigrams2.has(b)));
		const union = new Set([...bigrams1, ...bigrams2]);

		if (union.size === 0) return 0;

		return intersection.size / union.size;
	}
}

module.exports = {
	Party,
	Member,
	Track
};