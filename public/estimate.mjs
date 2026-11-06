export function estimateCargo(catalog, context, group) {
  const profile = catalog.profiles.find(entry =>
    entry.maps.some(raid => raid.mapId === context.map && raid.modeId === context.mode));
  if (!profile) return null;

  const allowed = new Map(group.items.map(item => [item.id, item]));
  const weights = new Map();
  const poolPrices = new Set();
  for (const pool of catalog.pools) {
    if (pool.profile !== profile.id || (context.cargo && pool.typeId !== context.cargo)) continue;
    if (context.asking && ![100, 90, 80].some(percent => Math.floor(pool.price * percent / 100) === context.asking)) continue;
    for (const candidate of pool.items) {
      if (!allowed.has(candidate.id)) continue;
      const weight = pool.weight / profile.groupWeightTotal * candidate.weight / pool.weightTotal;
      if (!(weight > 0)) continue;
      weights.set(candidate.id, (weights.get(candidate.id) ?? 0) + weight);
      poolPrices.add(pool.price);
    }
  }

  const exactSize = context.width && context.height ? [...weights].filter(([id]) => {
    const item = allowed.get(id);
    return (item.width === context.width && item.height === context.height) ||
      (item.width === context.height && item.height === context.width);
  }) : [];
  const candidates = exactSize.length ? exactSize : [...weights];
  const sum = candidates.reduce((total, [, value]) => total + value, 0);
  const items = candidates.map(([id, weight]) => ({ ...allowed.get(id), probability: weight / sum }))
    .sort((left, right) => right.probability - left.probability);
  const redChance = items.reduce((total, item) => total + (item.rarity === 6 ? item.probability : 0), 0);
  const expectedValue = items.reduce((total, item) => total + item.price * item.probability, 0);
  return {
    items, redChance, expectedValue,
    expectedNet: context.asking ? expectedValue - context.asking : null,
    poolPrices: [...poolPrices].sort((a, b) => a - b),
  };
}
