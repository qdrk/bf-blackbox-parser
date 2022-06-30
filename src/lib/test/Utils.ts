export function allIndicesOf(list, searched) {
  const indices = [];

  let startIndex = 0;
  while (startIndex < list.length) {
    const index = list.indexOf(searched, startIndex);

    if (index == -1) {
      break;
    }

    indices.push(index);

    startIndex = index + 1;
  }

  return indices;
}
