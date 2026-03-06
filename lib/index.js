"use strict";

const chalk = require("chalk");
const { version } = require("../package.json");
// Gradient Title

const gradient = require("gradient-string")
const title = gradient.pastel("✨ Initializing Baileys System ✨");
const versionText = gradient.cristal(`Version Synced: ${version}`);

console.log("\n" + title);
console.log(versionText + "\n");
// Spinner Animation
const frames = ["🌌", "✨", "🌙", "🔮", "💫", "⚡"];
let i = 0;
let step = 0;

const spinnerInterval = setInterval(() => {
  const frame = frames[i = ++i % frames.length];

  let text;
  if (step === 0) text = chalk.cyanBright("Starting engine...");
  if (step === 1) text = chalk.magentaBright("Connecting to Baileys core...");
  if (step === 2) text = chalk.yellowBright("Syncing configuration...");

  console.clear();
  console.log(title);
  console.log(versionText + "\n");
  console.log(`${frame}  ${text}`);
}, 130);

// STEP TRANSITION
setTimeout(() => step = 1, 2000);
setTimeout(() => step = 2, 4000);
// FINISH
setTimeout(() => {
  clearInterval(spinnerInterval);

  console.clear();
  console.log(title);
  console.log(versionText + "\n");
  console.log(chalk.greenBright("✔ ✨ Baileys System Ready!"));
  console.log(chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.whiteBright("🔥 Running Bailey Sistem!"));
  console.log(chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
  console.log(chalk.cyanBright.bold("\n👑 Creator : ") + chalk.magentaBright.bold("amel") + "\n");
  console.log(chalk.cyanBright.bold("🚀 GitHub   : ") + chalk.cyanBright.bold("amel") + "\n");
  console.log(chalk.cyanBright.bold("⚡ Masukan Nomornya  : ") + chalk.cyanBright.bold("628xxx") + "\n");
}, 6500);

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeWASocket = void 0;
const Socket_1 = __importDefault(require("./Socket"));
exports.makeWASocket = Socket_1.default;
__exportStar(require("../WAProto"), exports);
__exportStar(require("./Utils"), exports);
__exportStar(require("./Types"), exports);
__exportStar(require("./Store"), exports);
__exportStar(require("./Defaults"), exports);
__exportStar(require("./WABinary"), exports);
__exportStar(require("./WAM"), exports);
__exportStar(require("./WAUSync"), exports);

exports.default = Socket_1.default;





