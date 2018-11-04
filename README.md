# log-viewer
Hackable log viewer built with `nw.js` and `react`. 

# Installation

```bash
git clone https://github.com/KevinWang15/log-viewer
cd log-viewer
npm i
npm run build-nw
ln -s $(pwd)/build/log-viewer /usr/local/bin/log-viewer
```

# How to use
```bash
log-viewer a.log
collect-logs | log-viewer
```

# License

MIT

# TODO
- [ ] Use lazy scroll view
- [ ] Option to show all occurrences in search result
- [ ] Currently it only works on MacOS, add support for other platforms
- [ ] Pack and release as app (on various platforms)