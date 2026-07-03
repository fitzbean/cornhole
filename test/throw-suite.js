// Deterministic throw regression suite for the bag physics-feel work.
//
// Usage: paste into the browser console (or drive via preview_eval) on a page
// where the game is running (after clicking Play Local). The game exposes
// window.testSetup / testThrow / testSnapshot / testResetBags / advanceTime
// from CornholeGame.installTestingHooks().
//
// 1. Capture a baseline (run BEFORE physics changes, or with neutral presets):
//      runThrowSuite('bagBaseline')
//    Runs the 300-throw grid and stores results in localStorage under the key.
//    Run it in chunks if the console/eval times out: runThrowSuite('bagBaseline', 50)
//    repeatedly until it reports complete:true.
//
// 2. Compare a candidate run against the baseline:
//      runThrowSuite('bagCandidate')            // capture with new physics on
//      compareThrowRuns('bagBaseline', 'bagCandidate')
//    Pass criteria (from the implementation plan):
//      - neutral preset vs baseline: identical within float noise
//      - tuned preset vs baseline: mean |dRestZ| < 0.10 m per grid cell,
//        hole-capture-rate delta < 3% absolute, no new off-board outcomes.

function throwSuiteCases() {
  const cases = [];
  for (const style of ['slide', 'roll'])
    for (const pull of [0.35, 0.5, 0.65, 0.8, 0.95])
      for (const aimX of [-0.5, 0, 0.5])
        for (const side of ['sticky', 'slick'])
          for (const seed of [1, 2, 3, 4, 5])
            cases.push({ style, pull, aimX, side, seed });
  return cases;
}

function runThrowSuite(key, chunk = 300) {
  const cases = throwSuiteCases();
  const wipKey = key + '_wip';
  const results = JSON.parse(localStorage.getItem(wipKey) || '[]');
  window.testSetup();
  let n = chunk;
  while (n-- > 0 && results.length < cases.length) {
    const c = cases[results.length];
    window.testResetBags();
    window.advanceTime(100);
    const ok = window.testThrow(c);
    window.advanceTime(4000);
    const snap = window.testSnapshot();
    const bag = snap.bags.find(b => b.visible || b.inHole);
    results.push({
      ...c, ok,
      x: bag ? +bag.x.toFixed(4) : null,
      y: bag ? +bag.y.toFixed(4) : null,
      z: bag ? +bag.z.toFixed(4) : null,
      inHole: bag ? bag.inHole : null,
      score: snap.player1RoundScore + snap.player2RoundScore,
    });
  }
  localStorage.setItem(wipKey, JSON.stringify(results));
  if (results.length >= cases.length) {
    localStorage.setItem(key, JSON.stringify(results));
    localStorage.removeItem(wipKey);
    return { key, done: results.length, complete: true };
  }
  return { key, done: results.length, total: cases.length, complete: false };
}

function compareThrowRuns(baseKey, candKey) {
  const base = JSON.parse(localStorage.getItem(baseKey));
  const cand = JSON.parse(localStorage.getItem(candKey));
  if (!base || !cand || base.length !== cand.length) {
    return { error: 'missing or mismatched runs', base: base?.length, cand: cand?.length };
  }
  let maxDz = 0, maxDx = 0, sumDz = 0, holesBase = 0, holesCand = 0, moved = [];
  for (let i = 0; i < base.length; i++) {
    const b = base[i], c = cand[i];
    if (b.inHole) holesBase++;
    if (c.inHole) holesCand++;
    const dz = Math.abs((c.z ?? 0) - (b.z ?? 0));
    const dx = Math.abs((c.x ?? 0) - (b.x ?? 0));
    sumDz += dz;
    if (dz > maxDz) maxDz = dz;
    if (dx > maxDx) maxDx = dx;
    if (dz > 0.10 || dx > 0.10 || b.inHole !== c.inHole || b.score !== c.score) {
      moved.push({ i, case: `${b.style}/p${b.pull}/a${b.aimX}/${b.side}/s${b.seed}`,
        dz: +dz.toFixed(3), dx: +dx.toFixed(3),
        holeChange: b.inHole !== c.inHole ? `${b.inHole}->${c.inHole}` : null,
        scoreChange: b.score !== c.score ? `${b.score}->${c.score}` : null });
    }
  }
  return {
    meanDz: +(sumDz / base.length).toFixed(4),
    maxDz: +maxDz.toFixed(4),
    maxDx: +maxDx.toFixed(4),
    holeCaptureDelta: holesCand - holesBase,
    holeCaptureRateDeltaPct: +(((holesCand - holesBase) / base.length) * 100).toFixed(2),
    changedCells: moved.length,
    changed: moved.slice(0, 25),
  };
}
