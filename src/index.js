import React from "react";
import ReactDOM from "react-dom";
import App from "./App.jsx";
import "./index.css";
// import { whyDidYouUpdate } from 'why-did-you-update';
// whyDidYouUpdate(React);

const fs = window['require']("fs");

let log = fs.readFileSync(window['require']('nw.gui').App.argv[0], {encoding: "UTF8"});

let root = document.getElementById('root');

ReactDOM.render(<App log={log}/>, root);