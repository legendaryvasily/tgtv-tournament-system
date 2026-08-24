const usersRepo = require("../db/repositories/users");
const gamesRepo = require("../db/repositories/games");
const tournamentMatchesRepo = require("../db/repositories/tournament-matches");
const { calculateElo, ELO_K } = require("../domain/elo");
const { matchScoreFor } = require("../domain/scoring");

const UNREGISTERED_OPPONENT_RATING_BONUS = 15;

function eloDeltaFor(game, userId) {
  return Number(game.elo?.[userId]?.delta || 0);
}

function inferBaseRatings(users, games, { splitFromLegacyRating = false } = {}) {
  const ratings = {
    tts: new Map(),
    irl: new Map()
  };
  for (const user of users) {
    if (splitFromLegacyRating) {
      ratings.tts.set(user.id, Number(user.rating || 0));
      ratings.irl.set(user.id, Number(user.rating || 0));
    } else {
      ratings.tts.set(user.id, usersRepo.ratingForVenue(user, "tts"));
      ratings.irl.set(user.id, usersRepo.ratingForVenue(user, "irl"));
    }
  }
  for (const game of games) {
    const venue = splitFromLegacyRating ? null : usersRepo.normalizeVenueMode(game.venueMode);
    for (const userId of game.playerIds || []) {
      const delta = eloDeltaFor(game, userId);
      const tracks = venue ? [ratings[venue]] : [ratings.tts, ratings.irl];
      for (const track of tracks) {
        if (!track.has(userId)) continue;
        track.set(userId, track.get(userId) - delta);
      }
    }
  }
  return ratings;
}

function isRankedGame(game, tournamentPolicies) {
  if (game.sourceType === "challenge") return true;
  if (game.sourceType === "tournament_match") {
    return game.tournament?.ratingPolicy === "ranked" || tournamentPolicies.get(game.id) === "ranked";
  }
  return Boolean(game.elo);
}

function replayGame(game, ratings) {
  const playerIds = (game.playerIds || []).filter(Number.isInteger);
  if (game.sourceType === "tournament_match" && playerIds.length === 1) {
    const [playerId] = playerIds;
    if (!ratings.has(playerId)) return null;
    const before = ratings.get(playerId);
    const after = before + UNREGISTERED_OPPONENT_RATING_BONUS;
    ratings.set(playerId, after);
    return {
      flat: UNREGISTERED_OPPONENT_RATING_BONUS,
      [playerId]: { before, after, delta: UNREGISTERED_OPPONENT_RATING_BONUS }
    };
  }

  const [playerAId, playerBId] = playerIds;
  if (!Number.isInteger(playerAId) || !Number.isInteger(playerBId)) return null;
  if (!ratings.has(playerAId) || !ratings.has(playerBId)) return null;

  const beforeA = ratings.get(playerAId);
  const beforeB = ratings.get(playerBId);
  const matchScoreA = matchScoreFor(game.result, playerAId, playerBId);
  const { deltaA, deltaB } = calculateElo(beforeA, beforeB, matchScoreA);
  const afterA = beforeA + deltaA;
  const afterB = beforeB + deltaB;
  ratings.set(playerAId, afterA);
  ratings.set(playerBId, afterB);

  return {
    k: ELO_K,
    [playerAId]: { before: beforeA, after: afterA, delta: deltaA },
    [playerBId]: { before: beforeB, after: afterB, delta: deltaB }
  };
}

function ratingReplayOrder(a, b) {
  const timestamp = String(a.submittedAt || a.createdAt || "").localeCompare(
    String(b.submittedAt || b.createdAt || "")
  );
  if (timestamp) return timestamp;
  return String(a.id).localeCompare(String(b.id));
}

async function recalculateCompletedGameRatings(client, options = {}) {
  const users = await usersRepo.listForRatingReplay(client);
  const games = await gamesRepo.listCompletedForRatingReplay(client);
  const replayGames = games.sort(ratingReplayOrder);
  const tournamentGameIds = games
    .filter((game) => game.sourceType === "tournament_match")
    .map((game) => game.id);
  const tournamentPolicies = await tournamentMatchesRepo.ratingPoliciesByGameIds(client, tournamentGameIds);
  const ratings = inferBaseRatings(users, replayGames, options);

  for (const game of replayGames) {
    const venue = usersRepo.normalizeVenueMode(game.venueMode);
    const elo = isRankedGame(game, tournamentPolicies) ? replayGame(game, ratings[venue]) : null;
    await gamesRepo.updateElo(client, game.id, elo);
  }

  for (const user of users) {
    const next = {
      tts: ratings.tts.get(user.id),
      irl: ratings.irl.get(user.id)
    };
    if (
      Number.isInteger(next.tts) &&
      Number.isInteger(next.irl) &&
      (next.tts !== usersRepo.ratingForVenue(user, "tts") || next.irl !== usersRepo.ratingForVenue(user, "irl"))
    ) {
      await usersRepo.setRatings(client, user.id, next);
    }
  }

  await tournamentMatchesRepo.syncEloFromLinkedGames(client);
}

module.exports = { recalculateCompletedGameRatings };
