const path = require('path');
const shell = require("shelljs");

module.exports = {
  target: "node",
  node: {
    __dirname: false,
    __filename: false
  },
  entry: {
    starter: ["./src/starter.js"]
  },
  output: {
    path: path.resolve(__dirname, "./build"),
    filename: "log-viewer"
  },
  externals: [],
  plugins: [
    function () {
      this.plugin('done', () => {
        shell
          .echo('#!/usr/bin/env node\n')
          .cat(`${__dirname}/build/log-viewer`)
          .to(`${__dirname}/build/log-viewer`);
        shell.chmod(755, `${__dirname}/build/log-viewer`);
      })
    },
  ]
};