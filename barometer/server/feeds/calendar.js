/** Deterministic calendar signals. No network. Value 1 inside the window, tapering in over the lead-in. */
function windowScore(now, startMD, endMD, leadDays) {
  const y = now.getUTCFullYear()
  const mk = (md, yy) => new Date(Date.UTC(yy, md[0] - 1, md[1]))
  for (const yy of [y - 1, y, y + 1]) {
    const s = mk(startMD, yy), e = mk(endMD, endMD[0] < startMD[0] ? yy + 1 : yy)
    if (now >= s && now <= e) return 1
    const lead = (s - now) / 86400000
    if (lead > 0 && lead <= leadDays) return +(1 - lead / leadDays).toFixed(2)
  }
  return 0
}
module.exports = {
  id: 'calendar', name: 'Calendar seasons', family: 'calendar', cadence: '0 4 * * *', requires: null, metrics: ['cal_newyear','cal_backtoschool','cal_shedding'],
  windowScore,
  async fetch() {
    const now = new Date(); const at = now.toISOString(); const geo = { kind: 'national' }
    return [
      { metric: 'cal_newyear',      geo, value: windowScore(now, [12, 26], [1, 20], 14), observedAt: at },
      { metric: 'cal_backtoschool', geo, value: windowScore(now, [8, 1], [9, 10], 14), observedAt: at },
      { metric: 'cal_shedding',     geo, value: Math.max(windowScore(now, [3, 15], [5, 15], 14), windowScore(now, [9, 15], [11, 1], 14)), observedAt: at }
    ]
  }
}
