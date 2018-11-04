function makeSegments(line) {
  let isInQuotes = false;
  let segments = [];
  let buffer = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      if (line[i] === "\\") {
        buffer += "\\";
      } else {
        // eslint-disable-next-line
        buffer += eval('"' + "\\" + line[i] + '"');
      }
    } else if (line[i] === "\"") {
      isInQuotes = !isInQuotes;
      if (!isInQuotes) {
        segments.push(buffer);
        buffer = "";
      }
    } else if (line[i] === " " && !isInQuotes) {
      if (buffer !== "") {
        segments.push(buffer);
        buffer = "";
      }
    } else {
      buffer += line[i];
    }
  }
  if (buffer !== "") {
    segments.push(buffer);
  }
  return segments;
}

export default function matches(line, segments) {
  line = line.toLowerCase();
  segments = makeSegments(segments.toLowerCase()).map(a => a.trim());
  let validSegments = 0;
  let hasHit = false;
  for (let segment of segments) {
    if (segment.startsWith("-")) {
      if (line.indexOf(segment.substr(1)) >= 0) {
        return false;
      } else {
        continue;
      }
    }
    if (segment.startsWith("+")) {
      if (line.indexOf(segment.substr(1)) < 0) {
        return false;
      } else {
        hasHit = true;
        continue;
      }
    }
    validSegments++;
    if (line.indexOf(segment.substr(1)) >= 0) {
      hasHit = true;
    }
  }
  return hasHit || validSegments === 0;
}