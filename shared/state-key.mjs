// The one place a block state becomes a string key. The census, the asset packer and the chunk
// decoder all build keys through this, so a chunk can look up the state record the packer baked.
export function stateKey(name, props) {
  if (!props) return name;
  const keys = Object.keys(props);
  if (!keys.length) return name;
  keys.sort();
  let s = name + '|';
  for (let i = 0; i < keys.length; i++) {
    if (i) s += ',';
    s += keys[i] + '=' + props[keys[i]];
  }
  return s;
}
