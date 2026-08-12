import type { InputState } from "../engine/characterController";
export const INPUT_SIZE=8;
export const InputBits={LEFT:1,RIGHT:2,FORWARD:4,BACK:8,JUMP:16,DIVE:32,SLIDE:64,WALLRUN:128,FIRE:1,MELEE:2,BULLET:4} as const;
export type EncodedInput=Uint8Array;
export function encodeInput(s:InputState):EncodedInput { const b=new Uint8Array(INPUT_SIZE); if(s.right<0)b[0]|=1;if(s.right>0)b[0]|=2;if(s.forward>0)b[0]|=4;if(s.forward<0)b[0]|=8;if(s.jumpPressed)b[0]|=16;if(s.divePressed)b[0]|=32;if(s.slideHeld)b[0]|=64;if(s.wallrunPressed)b[0]|=128;return b; }
export function decodeInput(b:Uint8Array):InputState{return {forward:(b[0]&4?1:0)-(b[0]&8?1:0),right:(b[0]&2?1:0)-(b[0]&1?1:0),jumpPressed:!!(b[0]&16),divePressed:!!(b[0]&32),slideHeld:!!(b[0]&64),wallrunPressed:!!(b[0]&128),cameraTogglePressed:false,fireHeld:false,meleePressed:false,bulletTimeHeld:false};}
