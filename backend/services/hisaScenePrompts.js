const MAX_FLOW_SCENES_COUNT = 5;

export function getFlowScenesCount() {
  const count = Number(process.env.FLOW_SCENES_COUNT || 3);
  if (!Number.isInteger(count) || count < 1 || count > MAX_FLOW_SCENES_COUNT) {
    throw new Error('FLOW_SCENES_COUNT must be an integer from 1 to 5.');
  }
  return count;
}

export function createHisaScenePrompts(sourcePrompts) {
  const count = getFlowScenesCount();
  if (!Array.isArray(sourcePrompts) ||
      sourcePrompts.length === 0 ||
      sourcePrompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new Error('Hisa source scenePrompts must be a non-empty array of strings.');
  }

  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sourcePrompts.length / count);
    const end = Math.floor((index + 1) * sourcePrompts.length / count);
    const moments = sourcePrompts.slice(start, end);
    if (!moments.length) moments.push(sourcePrompts[index % sourcePrompts.length]);
    return `Create one continuous 9:16 vertical animated video that progresses through these story moments: ${moments.join(' NEXT MOMENT: ')}`;
  });
}
