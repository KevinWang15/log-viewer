let tmp = require('tmp');
let stdin = process.stdin;
let argv = process.argv;
let fs = require("fs");
let childprocess = require("child_process");
let commandExistsSync = require('command-exists').sync;

if (!commandExistsSync("nwjs")) {
  console.error("\nError: `nwjs` not found!\n" +
    "\n" +
    "Download it (normal version) from  https://nwjs.io/downloads/\n" +
    "\n" +
    "And add the following line to `~/.bash_profile`\n" +
    "export PATH=$PATH:<WhereYouExtractIt>/nwjs.app/Contents/MacOS\n");

  process.exit();
}

new Promise(resolve => {
  let ret = '';
  if (argv.length === 3) {
    resolve(argv[2]);
  } else if (process.stdin.isTTY) {
    console.log("Usage\n    log-viewer <filename>\n    do-something | log-viewer\n");
  } else {
    stdin.setEncoding('utf8');
    stdin.on('readable', function () {
      let chunk;
      while (chunk = stdin.read()) {
        ret += chunk;
      }
    });

    stdin.on('end', function () {
      tmp.file((err, path) => {
        if (err) throw err;
        fs.writeFileSync(path, ret, {encoding: "UTF8"});
        resolve(path);
      });
    });
  }
}).then(fileName => {
  childprocess.spawn("nwjs", [".", fileName]);
});
