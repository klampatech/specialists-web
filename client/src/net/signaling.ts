export interface ClipboardPayload { type:"offer"|"answer"; sdp:RTCSessionDescriptionInit; candidates:RTCIceCandidateInit[] }
export const encodePayload=(p:ClipboardPayload)=>btoa(JSON.stringify(p));
export function decodePayload(s:string):ClipboardPayload {try {const p:unknown=JSON.parse(atob(s.trim()));if(!p||typeof p!=="object"||!("type" in p)||!("sdp" in p))throw 0;return p as ClipboardPayload;}catch{throw new Error("Could not parse — make sure you pasted the full blob");}}
export const joinBlob=()=>new URLSearchParams(location.search).get("join");
