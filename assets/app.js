import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue, remove, push, increment, runTransaction } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBreTSe1m0-xlbF4aupnU5isRZCihR25IE",
  authDomain: "formwheel.firebaseapp.com",
  databaseURL: "https://formwheel-default-rtdb.firebaseio.com",
  projectId: "formwheel",
  storageBucket: "formwheel.firebasestorage.app",
  messagingSenderId: "431583088241",
  appId: "1:431583088241:web:74e0e34ea1e3e1170c55d0",
  measurementId: "G-T372YXDF8D"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const MAX_PLAYERS=6, MAX_ROUNDS=6;
const FATE_BREAK_THRESHOLD=6; // Fate Debt가 이 값 이상이면 다음 스핀에 FATE BREAK 이벤트가 섞인다
const LEADER_BONUS=1.15; // 전체 누적 선택 횟수 1위 운명에 적용되는 특별 배율
let room="", playerId="", nickname="", isHost=false, roomData=null;
let unsubscribe=null, selectedChoice="", localSpun=false, spinning=false;
let globalStats={safe:0,greed:0,chaos:0,revenge:0};

// 전체 게임(모든 방)에서 누적된 운명별 선택 횟수를 구독한다.
// 이 값은 FormWheel 메인 페이지의 리더보드/통계와 동일한 Firebase 경로를 사용한다.
onValue(ref(db,"globalStats/choiceCounts"),snap=>{
  const v=snap.val()||{};
  globalStats={safe:v.safe||0,greed:v.greed||0,chaos:v.chaos||0,revenge:v.revenge||0};
  renderGlobalPanel();
  if(game && !game.classList.contains("hidden")) showGame();
});

function getLeaderChoice(){
  const entries=Object.entries(globalStats);
  const total=entries.reduce((a,[,v])=>a+v,0);
  if(!total)return null;
  entries.sort((a,b)=>b[1]-a[1]);
  const [choice,count]=entries[0];
  return {choice,count,total};
}

function renderGlobalPanel(){
  const el=$("globalPanel");
  if(!el)return;
  const leader=getLeaderChoice();
  if(!leader){
    el.innerHTML=`<p style="margin:0">아직 전체 게임 기록이 없어. 첫 스핀이 통계를 시작해!</p>`;
    return;
  }
  const label=STYLE_LABELS[leader.choice];
  el.innerHTML=`
    <p style="margin:0 0 6px">이때까지 <b>${label}</b>이(가) 총 <b>${leader.count.toLocaleString()}</b>번 선택되었습니다. (전체 1위)</p>
    <p style="margin:0;color:#171923;font-weight:800">→ ${label}에 특별 효과가 적용됩니다 (결과 폭 x${LEADER_BONUS})</p>
    <div class="styleLegend" style="margin-top:8px">
      ${Object.entries(globalStats).map(([k,v])=>`<span><b style="color:${STYLE_COLORS[k]}">●</b> ${STYLE_LABELS[k]} ${v.toLocaleString()}회</span>`).join("")}
    </div>`;
}

const $=id=>document.getElementById(id);
const setup=$("setup"), lobby=$("lobby"), game=$("game"), result=$("result");

function show(el){[setup,lobby,game,result].forEach(x=>x.classList.add("hidden"));el.classList.remove("hidden")}
function msg(el,text,danger=false){el.textContent=text;el.classList.remove("hidden");el.classList.toggle("danger",danger)}
function cleanName(s){return String(s||"").trim().slice(0,12)}
function validCode(s){return /^\d{4}$/.test(s)}
function makeCode(){return String(Math.floor(1000+Math.random()*9000))}
function pid(){return "p_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8)}

$("createBtn").onclick=async()=>{
  nickname=cleanName($("nickname").value);
  if(!nickname)return msg($("setupMsg"),"닉네임을 입력해줘.",true);
  room=makeCode(); playerId=pid(); isHost=true;
  const roomRef=ref(db,"fateRooms/"+room);
  const existing=await get(roomRef);
  if(existing.exists()){ $("createBtn").click(); return; }
  const data={
    meta:{host:playerId,status:"lobby",round:0,maxPlayers:MAX_PLAYERS,maxRounds:MAX_ROUNDS,createdAt:Date.now()},
    players:{[playerId]:{nickname,score:0,debt:0,choice:"",spun:false,style:{safe:0,greed:0,chaos:0,revenge:0},streak:{choice:"",count:0},joinedAt:Date.now()}}
  };
  await set(roomRef,data);
  enterRoom();
};

$("joinBtn").onclick=async()=>{
  nickname=cleanName($("nickname").value);
  room=$("roomCode").value.trim();
  if(!nickname)return msg($("setupMsg"),"닉네임을 입력해줘.",true);
  if(!validCode(room))return msg($("setupMsg"),"4자리 방 코드를 입력해줘.",true);
  const snap=await get(ref(db,"fateRooms/"+room));
  if(!snap.exists())return msg($("setupMsg"),"존재하지 않는 방이야.",true);
  const d=snap.val();
  const count=Object.keys(d.players||{}).length;
  if(count>=MAX_PLAYERS)return msg($("setupMsg"),"이 방은 이미 6명이야.",true);
  if(d.meta?.status!=="lobby")return msg($("setupMsg"),"이미 게임이 시작된 방이야.",true);
  playerId=pid(); isHost=false;
  await update(ref(db,"fateRooms/"+room+"/players/"+playerId),{
    nickname,score:0,debt:0,choice:"",spun:false,
    style:{safe:0,greed:0,chaos:0,revenge:0},streak:{choice:"",count:0},joinedAt:Date.now()
  });
  enterRoom();
};

function enterRoom(){
  $("roomDisplay").textContent=room;
  show(lobby);
  if(unsubscribe)unsubscribe();
  unsubscribe=onValue(ref(db,"fateRooms/"+room),snap=>{
    if(!snap.exists()){leaveLocal();return}
    roomData=snap.val(); renderRoom();syncFateStatistics(roomData).catch(console.error);
  });
}

let syncingStatistics=false;
async function syncFateStatistics(data){
 const receipts=data?.spinReceipts;if(!receipts||syncingStatistics)return;syncingStatistics=true;
 try{await runTransaction(ref(db,"globalStats"),stats=>{
  stats=stats||{};stats.spinReceipts=stats.spinReceipts||{};stats.choiceCounts=stats.choiceCounts||{};let changed=false;
  for(const [id,receipt] of Object.entries(receipts))if(!stats.spinReceipts[id]){
   stats.spinReceipts[id]=true;stats.choiceCounts[receipt.choice]=(Number(stats.choiceCounts[receipt.choice])||0)+1;changed=true;
  }return changed?stats:undefined;
 },{applyLocally:false});}catch{console.warn("선택 통계를 연결 복구 후 재전송합니다.");}finally{syncingStatistics=false;}
}
setInterval(()=>{if(roomData)syncFateStatistics(roomData)},5000);
function renderRoom(){
  const players=roomData.players||{};
  const list=Object.entries(players);
  $("playerCount").textContent=list.length;
  $("players").innerHTML=list.map(([id,p])=>`
    <div class="player ${id===playerId?"me":""}">
      <div><span class="dot"></span><b>${escapeHtml(p.nickname||"Player")}</b></div>
      <small>${id===roomData.meta?.host?"👑 호스트":"참가자"}</small>
    </div>`).join("");
  $("startBtn").disabled=roomData.meta?.host!==playerId || list.length<1;
  $("startBtn").textContent=list.length>=2?"게임 시작":"게임 시작 (혼자도 가능)";
  if(roomData.meta?.status==="playing") showGame();
  if(roomData.meta?.status==="result") showResult();
}

$("startBtn").onclick=async()=>{
  if(roomData?.meta?.host!==playerId)return;
  await update(ref(db,"fateRooms/"+room+"/meta"),{status:"playing",round:1,phase:"spinning"});
};

$("leaveBtn").onclick=async()=>{
  if(!room)return;
  if(isHost){
    const players=Object.keys(roomData?.players||{}).filter(x=>x!==playerId);
    if(players.length){
      const newHost=players[0];
      await update(ref(db,"fateRooms/"+room+"/meta"),{host:newHost});
      await remove(ref(db,"fateRooms/"+room+"/players/"+playerId));
      isHost=false;
    }else await remove(ref(db,"fateRooms/"+room));
  }else await remove(ref(db,"fateRooms/"+room+"/players/"+playerId));
  leaveLocal();
};

function leaveLocal(){
  if(unsubscribe)unsubscribe();
  unsubscribe=null; room="";playerId="";isHost=false;roomData=null;
  show(setup);
}

function showGame(){
  show(game);
  const round=roomData.meta.round||1;
  $("roundText").textContent=`ROUND ${round} / ${MAX_ROUNDS}`;
  const me=roomData.players?.[playerId];
  selectedChoice=me?.choice||"";
  localSpun=!!me?.spun;
  document.querySelectorAll(".choice").forEach(b=>b.classList.toggle("selected",b.dataset.choice===selectedChoice));
  $("spinBtn").disabled=!selectedChoice||localSpun||spinning;
  $("spinBtn").textContent=localSpun?"돌리기 완료":"내 운명 돌리기";
  const debt=me?.debt||0;
  $("debtText").textContent="Fate Debt "+debt;
  $("debtText").className="badge"+(debt>=FATE_BREAK_THRESHOLD?" break":debt>=3?" warn":"");
  const banner=$("fateBreakBanner");
  if(debt>=FATE_BREAK_THRESHOLD && !localSpun){
    banner.classList.remove("hidden");
    banner.textContent="⚠️ FATE BREAK — 운명의 빚이 너무 높습니다. 이번 Wheel에는 특수 결과가 추가됩니다.";
  }else banner.classList.add("hidden");
  renderScores();
  renderStyleBar(me);
  renderGlobalPanel();
  const leader=getLeaderChoice();
  document.querySelectorAll(".choice").forEach(b=>{
    b.querySelector(".leaderTag")?.classList.toggle("hidden",!(leader&&leader.choice===b.dataset.choice));
  });
  drawWheel(makeSegments(roomData),0,selectedChoice);
  const all=Object.values(roomData.players||{});
  const done=all.length>0&&all.every(p=>p.spun);
  if(roomData.meta.host===playerId){
    $("nextBtn").classList.toggle("hidden",!done);
    $("nextBtn").disabled=!done;
  }else $("nextBtn").classList.add("hidden");
}

function renderScores(){
  $("scoreGrid").innerHTML=Object.entries(roomData.players||{}).map(([id,p])=>`
    <div class="score"><span>${escapeHtml(p.nickname||"Player")}${id===playerId?" ★":""}</span><b>${p.score||0}</b><small>Debt ${p.debt||0}</small></div>`).join("");
}

const STYLE_COLORS={safe:"#2563eb",greed:"#d97706",chaos:"#7c3aed",revenge:"#dc2626"};
const STYLE_LABELS={safe:"안전",greed:"탐욕",chaos:"혼돈",revenge:"복수"};
function renderStyleBar(me){
  const style=me?.style||{safe:0,greed:0,chaos:0,revenge:0};
  const total=Object.values(style).reduce((a,b)=>a+b,0);
  const bar=$("styleBar"), legend=$("styleLegend");
  if(!total){
    bar.innerHTML=`<span style="width:100%;background:#eef0f5"></span>`;
    legend.innerHTML=`<span>아직 기록 없음</span>`;
    return;
  }
  bar.innerHTML=Object.entries(style).map(([k,v])=>{
    const pct=(v/total*100);
    return pct>0?`<span style="width:${pct}%;background:${STYLE_COLORS[k]}"></span>`:"";
  }).join("");
  legend.innerHTML=Object.entries(style).map(([k,v])=>{
    const pct=Math.round(v/total*100);
    return `<span><b style="color:${STYLE_COLORS[k]}">●</b> ${STYLE_LABELS[k]} ${pct}%</span>`;
  }).join("");
}

document.querySelectorAll(".choice").forEach(btn=>{
  btn.onclick=async()=>{
    if(localSpun)return;
    selectedChoice=btn.dataset.choice;
    document.querySelectorAll(".choice").forEach(b=>b.classList.toggle("selected",b===btn));
    drawWheel(makeSegments({...roomData,players:{...roomData.players,[playerId]:{...roomData.players[playerId],choice:selectedChoice}}}),0,selectedChoice);
    await update(ref(db,"fateRooms/"+room+"/players/"+playerId),{choice:selectedChoice});
    $("spinBtn").disabled=false;
    $("spinStatus").textContent="선택 완료! 이제 Wheel을 돌려봐.";
  };
});

$("spinBtn").onclick=async()=>{
  if(spinning||localSpun||!selectedChoice)return;
  spinning=true;$("spinBtn").disabled=true;
  $("spinStatus").textContent="운명이 움직이고 있어...";
  // Wheel에 실제로 보이는 동일한 배열에서 결과를 먼저 확정한다.
  const segments=makeSegments(roomData);
  const idx=Math.floor(Math.random()*segments.length);
  const outcome=segments[idx];
  const expectedRound=roomData.meta.round,choice=selectedChoice,receiptId=crypto.randomUUID();
  await animateWheelToIndex(segments, idx);
  const change=resolveOutcome(outcome,choice);
  const result=await runTransaction(ref(db,"fateRooms/"+room),current=>{
  if(!current||current.meta?.status!=="playing"||current.meta.round!==expectedRound||!current.players?.[playerId]||current.players[playerId].spun)return;
  const me=current.players[playerId];
  const oldScore=me.score||0, oldDebt=me.debt||0;
  let newScore=Math.max(0,oldScore+change.score);
  let extraUpdates={};

  if(change.special==="steal" && change.targetId){
    const target=current.players[change.targetId];
    const targetOld=Math.max(0,target?.score||0);
    const transfer=Math.max(-20,Math.min(20,change.transfer||0));
    if(transfer>0){
      const actual=Math.min(transfer,targetOld);
      newScore=Math.max(0,oldScore+actual);
      extraUpdates[`players/${change.targetId}/score`]=Math.max(0,targetOld-actual);
      change.message=`${change.targetName}에게서 ${actual}점을 스틸했어!`;
    }else if(transfer<0){
      const give=Math.min(Math.abs(transfer),oldScore);
      newScore=Math.max(0,oldScore-give);
      extraUpdates[`players/${change.targetId}/score`]=targetOld+give;
      change.message=`${change.targetName}에게 ${give}점을 넘겼어!`;
    }
  }

  if(change.special==="stealback" && change.targetId){
    // FATE BREAK 전용: 상대에게서 무조건 일정량을 되찾아온다
    const target=current.players[change.targetId];
    const targetOld=Math.max(0,target?.score||0);
    const actual=Math.min(change.amount||15,targetOld);
    newScore=Math.max(0,oldScore+actual);
    extraUpdates[`players/${change.targetId}/score`]=Math.max(0,targetOld-actual);
    change.message=`FATE BREAK! ${change.targetName}에게서 ${actual}점을 강제로 되찾았어!`;
  }

  if(change.special==="change" && change.targetId){
    const target=current.players[change.targetId];
    const targetScore=Math.max(0,target?.score||0);
    extraUpdates[`players/${change.targetId}/score`]=oldScore;
    newScore=targetScore;
    change.message=`${change.targetName}와 점수를 체인지! (${oldScore} ↔ ${targetScore})`;
  }

  const newDebt=Math.max(0,oldDebt+change.debt);
  const style={...(me.style||{safe:0,greed:0,chaos:0,revenge:0})};
  style[choice]=(style[choice]||0)+1;

  // 연속 선택 스트릭 갱신 (같은 운명을 반복 선택하면 다음 라운드 Wheel이 점점 극단적으로 변함)
  const prevStreak=me.streak||{choice:"",count:0};
  const streak=prevStreak.choice===choice
    ? {choice:choice,count:(prevStreak.count||0)+1}
    : {choice:choice,count:1};

  const updates={...extraUpdates,
   [`players/${playerId}/score`]:newScore,[`players/${playerId}/debt`]:newDebt,[`players/${playerId}/choice`]:choice,
   [`players/${playerId}/spun`]:true,[`players/${playerId}/style`]:style,[`players/${playerId}/streak`]:streak};
  for(const [path,value] of Object.entries(updates)){const [,id,key]=path.split('/');current.players[id][key]=value;}
  current.choiceCounts=current.choiceCounts||{};current.choiceCounts[choice]=(current.choiceCounts[choice]||0)+1;
  current.spinReceipts=current.spinReceipts||{};current.spinReceipts[receiptId]={choice,playerId,round:expectedRound};
  return current;
 },{applyLocally:false});
 if(!result.committed){spinning=false;$("spinStatus").textContent="이미 처리된 스핀이거나 라운드가 변경되었습니다.";return;}
 await syncFateStatistics(result.snapshot.val());
  $("eventBox").classList.remove("hidden");
  const resultText=change.message || `이번 결과: ${change.score>=0?"+":""}${change.score}점`;
  $("eventBox").innerHTML=`<b>${outcome.name}</b><br>${outcome.text}<br><small>${resultText}</small>`;
  $("spinStatus").textContent="결과가 저장되었어. 모든 플레이어가 돌리면 다음 라운드!";
  localSpun=true; spinning=false;
};

$("nextBtn").onclick=async()=>{
  if(roomData.meta.host!==playerId)return;
  const round=roomData.meta.round||1;
  if(round>=MAX_ROUNDS){
    // 게임 종료: 각 플레이어의 최종 결과를 메인 페이지에서 볼 수 있는
    // 전체 리더보드(leaderboard)에 기록한다. game 필드로 어떤 게임에서 온
    // 기록인지 구분해서, 다른 게임(Form/Wheel/Quiz/Battle)의 기록과 한 곳에서 볼 수 있게 한다.
    const entries=Object.values(roomData.players||{});
    await Promise.all(entries.map(p=>{
      const style=p.style||{safe:0,greed:0,chaos:0,revenge:0};
      const total=Object.values(style).reduce((a,b)=>a+b,0);
      const topStyle=total?Object.entries(style).sort((a,b)=>b[1]-a[1])[0][0]:"";
      return push(ref(db,"leaderboard"),{
        game:"fate",
        nickname:p.nickname||"Player",
        score:p.score||0,
        debt:p.debt||0,
        topStyle,
        room,
        date:Date.now()
      });
    }));
    await update(ref(db,"globalStats"),{gamesPlayed:increment(1)});
    await update(ref(db,"fateRooms/"+room+"/meta"),{status:"result",phase:"done"});
    return;
  }
  const updates={};
  for(const id of Object.keys(roomData.players||{})){
    updates[`players/${id}/choice`]="";
    updates[`players/${id}/spun`]=false;
  }
  updates["meta/round"]=round+1;
  updates["meta/phase"]="spinning";
  await update(ref(db,"fateRooms/"+room),updates);
  $("eventBox").classList.add("hidden");
};

$("againBtn").onclick=async()=>{
  if(!roomData || !room)return;
  try{
    const updates={"meta/status":"lobby","meta/round":0,"meta/phase":"waiting"};
    for(const id of Object.keys(roomData.players||{})){
      updates[`players/${id}/score`]=0;
      updates[`players/${id}/debt`]=0;
      updates[`players/${id}/choice`]="";
      updates[`players/${id}/spun`]=false;
      updates[`players/${id}/style`]={safe:0,greed:0,chaos:0,revenge:0};
      updates[`players/${id}/streak`]={choice:"",count:0};
    }

    // Firebase 저장과 동시에 화면도 즉시 로비로 전환한다.
    await update(ref(db,"fateRooms/"+room),updates);
    roomData.meta.status="lobby";
    roomData.meta.round=0;
    roomData.meta.phase="waiting";
    Object.values(roomData.players||{}).forEach(p=>{
      p.score=0;p.debt=0;p.choice="";p.spun=false;
      p.style={safe:0,greed:0,chaos:0,revenge:0};
      p.streak={choice:"",count:0};
    });
    renderRoom();
  }catch(err){
    alert("로비로 돌아가는 중 오류가 발생했어. Firebase 연결/보안 규칙을 확인해줘.");
    console.error(err);
  }
};

// 현재 플레이어의 선택 반복 횟수(스트릭)에 따라 배율을 계산한다.
// 같은 운명을 3번 이상 연속 선택하면 점수 폭이 커지고, 그만큼 Fate Debt 증가폭도 커진다.
function getEscalation(me,choice){
  const streak=me?.streak;
  const count=(streak && streak.choice===choice) ? (streak.count||0) : 0;
  // 3연속부터 단계적으로 강화, 최대 2.0배까지
  const level=Math.max(0,Math.min(4,count-2));
  const mult=1+level*0.25;
  return {mult,count};
}

function makeSegments(data){
  const me=data?.players?.[playerId];
  const choice=me?.choice||selectedChoice||"safe";
  const debt=me?.debt||0;
  const {mult}=getEscalation(me,choice);
  const leader=getLeaderChoice();
  const leaderMult=(leader && leader.choice===choice)?LEADER_BONUS:1;
  const scale=n=>Math.round(n*mult*leaderMult);

  let segs;

  // 선택한 운명마다 Wheel 자체가 완전히 달라진다.
  // 기본 범위: 안전 +10~-10 / 탐욕 +50~-50 / 복수 +10~-10 + 상대 스틸 ±20 / 혼돈 +30~-30 + 체인지
  // 같은 운명을 반복 선택할수록(streak) 위 숫자가 점점 극단적으로 벌어진다.
  if(choice==="safe"){
    segs=[
      {name:"+"+scale(10),text:"안전한 운명! "+scale(10)+"점을 얻는다.",score:scale(10),debt:0},
      {name:"+"+scale(7),text:"안전한 운명. "+scale(7)+"점을 얻는다.",score:scale(7),debt:0},
      {name:"+"+scale(4),text:"안전한 운명. "+scale(4)+"점을 얻는다.",score:scale(4),debt:0},
      {name:"+"+scale(1),text:"안전하게 "+scale(1)+"점을 얻는다.",score:scale(1),debt:0},
      {name:"0",text:"아무 일도 일어나지 않는다.",score:0,debt:0},
      {name:"-"+scale(1),text:"조금 흔들린다. "+scale(1)+"점을 잃는다.",score:-scale(1),debt:0},
      {name:"-"+scale(4),text:scale(4)+"점을 잃는다.",score:-scale(4),debt:0},
      {name:"-"+scale(7),text:scale(7)+"점을 잃는다.",score:-scale(7),debt:0},
      {name:"-"+scale(10),text:"안전한 운명의 최저 결과! "+scale(10)+"점을 잃는다.",score:-scale(10),debt:0}
    ];
  }else if(choice==="greed"){
    segs=[
      {name:"+"+scale(50),text:"대박! "+scale(50)+"점을 얻는다.",score:scale(50),debt:2},
      {name:"+"+scale(35),text:"탐욕의 큰 보상! "+scale(35)+"점을 얻는다.",score:scale(35),debt:2},
      {name:"+"+scale(20),text:scale(20)+"점을 얻는다.",score:scale(20),debt:1},
      {name:"+"+scale(10),text:scale(10)+"점을 얻는다.",score:scale(10),debt:1},
      {name:"0",text:"아무것도 얻지 못했다.",score:0,debt:1},
      {name:"-"+scale(10),text:"탐욕의 대가로 "+scale(10)+"점을 잃는다.",score:-scale(10),debt:1},
      {name:"-"+scale(20),text:scale(20)+"점을 잃는다.",score:-scale(20),debt:1},
      {name:"-"+scale(35),text:"큰 위험! "+scale(35)+"점을 잃는다.",score:-scale(35),debt:2},
      {name:"-"+scale(50),text:"탐욕의 최악의 결과! "+scale(50)+"점을 잃는다.",score:-scale(50),debt:3}
    ];
  }else if(choice==="revenge"){
    segs=[
      {name:"+"+scale(10),text:"복수 성공! "+scale(10)+"점을 얻는다.",score:scale(10),debt:0},
      {name:"+"+scale(7),text:"복수의 보상으로 "+scale(7)+"점을 얻는다.",score:scale(7),debt:0},
      {name:"+"+scale(4),text:scale(4)+"점을 얻는다.",score:scale(4),debt:0},
      {name:"+"+scale(1),text:scale(1)+"점을 얻는다.",score:scale(1),debt:0},
      {name:"0",text:"복수에 실패했다. 변화가 없다.",score:0,debt:0},
      {name:"-"+scale(1),text:"오히려 "+scale(1)+"점을 잃는다.",score:-scale(1),debt:0},
      {name:"-"+scale(4),text:scale(4)+"점을 잃는다.",score:-scale(4),debt:0},
      {name:"-"+scale(7),text:scale(7)+"점을 잃는다.",score:-scale(7),debt:0},
      {name:"-"+scale(10),text:"복수 실패! "+scale(10)+"점을 잃는다.",score:-scale(10),debt:0},
      {name:"STEAL ±"+scale(20),text:"상대 한 명의 점수를 최대 "+scale(20)+"점 범위에서 빼앗거나 넘겨받는다.",type:"steal",debt:1}
    ];
  }else{
    // chaos
    segs=[
      {name:"+"+scale(30),text:"혼돈의 대박! "+scale(30)+"점을 얻는다.",score:scale(30),debt:2},
      {name:"+"+scale(20),text:scale(20)+"점을 얻는다.",score:scale(20),debt:1},
      {name:"+"+scale(10),text:scale(10)+"점을 얻는다.",score:scale(10),debt:1},
      {name:"0",text:"혼돈 속에서 아무 변화도 없다.",score:0,debt:1},
      {name:"-"+scale(10),text:scale(10)+"점을 잃는다.",score:-scale(10),debt:1},
      {name:"-"+scale(20),text:scale(20)+"점을 잃는다.",score:-scale(20),debt:1},
      {name:"-"+scale(30),text:"혼돈의 최악의 결과! "+scale(30)+"점을 잃는다.",score:-scale(30),debt:2},
      {name:"CHANGE",text:"상대 한 명과 현재 점수를 서로 교체한다.",type:"change",debt:2}
    ];
  }

  // FATE BREAK: 운명의 빚이 임계치를 넘으면 특수 결과 칸이 Wheel에 추가된다.
  if(debt>=FATE_BREAK_THRESHOLD){
    segs=segs.concat([
      {name:"FATE BREAK -"+scale(40),text:"⚠️ FATE BREAK! 쌓인 운명의 빚이 폭발한다. "+scale(40)+"점을 잃는다.",score:-scale(40),debt:-3,type:"break"},
      {name:"STEAL BACK",text:"⚠️ FATE BREAK! 상대에게서 점수를 강제로 되찾아온다.",type:"stealback",debt:-2},
      {name:"DOUBLE LOSS",text:"⚠️ FATE BREAK! 이번 라운드 손실이 두 배가 된다.",type:"doubleloss",debt:-2}
    ]);
  }

  return segs;
}

function resolveOutcome(o,choice){
  let score=o.score||0;
  let debt=o.debt||0;
  let special=o.type||"";

  if(special==="steal"){
    const opponents=Object.entries(roomData.players||{}).filter(([id])=>id!==playerId);
    if(!opponents.length){
      return {score:0,debt,special:"none",message:"상대가 없어 스틸 효과가 취소되었어."};
    }
    const [targetId,target]=opponents[Math.floor(Math.random()*opponents.length)];
    let amount=Math.floor(Math.random()*41)-20; // -20 ~ +20
    const available=Math.max(0,target.score||0);
    if(amount>available) amount=available;
    // +면 상대에게서 빼앗아 내 점수로, -면 내가 상대에게 넘긴다.
    return {
      score:amount,
      debt,
      special:"steal",
      targetId,
      targetName:target.nickname||"상대",
      transfer:amount,
      message:amount>0
        ? `${target.nickname||"상대"}에게서 ${amount}점을 스틸했어!`
        : amount<0
          ? `${target.nickname||"상대"}에게 ${Math.abs(amount)}점을 빼앗겼어!`
          : `${target.nickname||"상대"}와 점수 이동이 없었어.`
    };
  }

  if(special==="change"){
    const opponents=Object.entries(roomData.players||{}).filter(([id])=>id!==playerId);
    if(!opponents.length){
      return {score:0,debt,special:"none",message:"상대가 없어 체인지 효과가 취소되었어."};
    }
    const [targetId,target]=opponents[Math.floor(Math.random()*opponents.length)];
    return {
      score:0,
      debt,
      special:"change",
      targetId,
      targetName:target.nickname||"상대",
      swapScore:target.score||0,
      message:`${target.nickname||"상대"}와 점수를 체인지!`
    };
  }

  if(special==="stealback"){
    const opponents=Object.entries(roomData.players||{}).filter(([id])=>id!==playerId);
    if(!opponents.length){
      return {score:0,debt,special:"none",message:"상대가 없어 STEAL BACK 효과가 취소되었어."};
    }
    // 점수가 가장 높은 상대에게서 되찾아온다.
    const [targetId,target]=opponents.sort((a,b)=>(b[1].score||0)-(a[1].score||0))[0];
    return {score:0,debt,special:"stealback",targetId,targetName:target.nickname||"상대",amount:15};
  }

  if(special==="doubleloss"){
    // 이번 라운드 성향(style)에서 가장 많이 선택한 운명 기준으로 손실 폭을 재계산해 2배로 적용.
    const base={safe:10,greed:50,chaos:30,revenge:10}[choice]||10;
    return {score:-base*2,debt,special:"doubleloss",message:`DOUBLE LOSS! ${base*2}점을 잃는다.`};
  }

  if(special==="break"){
    return {score,debt,special:"break",message:`FATE BREAK! ${Math.abs(score)}점을 잃는다.`};
  }

  return {score,debt,special:"score"};
}

function getChoiceTheme(choice){
  if(choice==="safe") return {fills:["#dbeafe","#eff6ff","#bfdbfe","#f8fbff"],accent:"#2563eb"};
  if(choice==="greed") return {fills:["#fef3c7","#fffbeb","#fde68a","#fffdf5"],accent:"#d97706"};
  if(choice==="chaos") return {fills:["#ede9fe","#faf5ff","#ddd6fe","#fcfaff"],accent:"#7c3aed"};
  if(choice==="revenge") return {fills:["#fee2e2","#fff1f2","#fecaca","#fff7f7"],accent:"#dc2626"};
  return {fills:["#ffffff","#eef0f5"],accent:"#171923"};
}

function drawWheel(segments,angle=0,choice=selectedChoice){
  const c=$("wheel"),ctx=c.getContext("2d"),w=c.width,h=c.height,r=170,cx=w/2,cy=h/2;
  ctx.clearRect(0,0,w,h);
  const n=segments.length,step=Math.PI*2/n;
  segments.forEach((s,i)=>{
    const a=angle+i*step;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+step);ctx.closePath();
    const theme=getChoiceTheme(choice);
    const isBreak=s.type==="break"||s.type==="stealback"||s.type==="doubleloss";
    ctx.fillStyle=isBreak?"#3a1010":theme.fills[i%theme.fills.length];ctx.fill();
    ctx.strokeStyle=isBreak?"#ff5555":theme.accent;ctx.globalAlpha=.42;ctx.stroke();ctx.globalAlpha=1;
    ctx.save();ctx.translate(cx,cy);ctx.rotate(a+step/2);ctx.textAlign="right";
    ctx.fillStyle=isBreak?"#ffdddd":"#171923";ctx.font=(isBreak?"900 12px":"800 15px")+" system-ui";
    ctx.fillText(s.name,r-12,5);ctx.restore();
  });
  const theme=getChoiceTheme(choice);
  ctx.beginPath();ctx.arc(cx,cy,39,0,Math.PI*2);ctx.fillStyle=theme.accent;ctx.fill();
  ctx.fillStyle="#fff";ctx.textAlign="center";ctx.font="900 14px system-ui";ctx.fillText("FATE",cx,cy+5);
  ctx.beginPath();ctx.moveTo(cx,cy-r-17);ctx.lineTo(cx-12,cy-r+5);ctx.lineTo(cx+12,cy-r+5);ctx.closePath();ctx.fillStyle=theme.accent;ctx.fill();
}
async function animateWheelToIndex(segments, idx){
  const start=performance.now(), duration=1800;
  const step=(Math.PI*2)/segments.length;

  // 화면 위쪽의 포인터(-90도)가 결과 칸의 정확한 중앙을 가리키도록
  // 최종 회전각을 계산한다.
  const startAngle=Math.random()*Math.PI*2;
  const finalBase=-Math.PI/2-(idx+0.5)*step;
  const turns=6+Math.floor(Math.random()*3);
  const finalAngle=finalBase+turns*Math.PI*2;

  return new Promise(resolve=>{
    function frame(now){
      const p=Math.min(1,(now-start)/duration);
      const e=1-Math.pow(1-p,4);
      const angle=startAngle+(finalAngle-startAngle)*e;
      drawWheel(segments,angle,selectedChoice);
      if(p<1){
        requestAnimationFrame(frame);
      }else{
        // 마지막 프레임을 다시 그려 결과 칸과 포인터가 정확히 일치하게 한다.
        drawWheel(segments,finalAngle,selectedChoice);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}
function showResult(){
  show(result);
  const list=Object.values(roomData.players||{}).sort((a,b)=>(b.score||0)-(a.score||0));
  $("finalScores").innerHTML=list.map(p=>{
    const style=p.style||{safe:0,greed:0,chaos:0,revenge:0};
    const total=Object.values(style).reduce((a,b)=>a+b,0);
    const top=total?Object.entries(style).sort((a,b)=>b[1]-a[1])[0]:null;
    const styleNote=top&&top[1]>0?`<br><small>${STYLE_LABELS[top[0]]} 성향 ${Math.round(top[1]/total*100)}%</small>`:"";
    return `<div class="score"><span>${escapeHtml(p.nickname||"Player")}</span><b>${p.score||0}</b><small>Fate Debt ${p.debt||0}</small>${styleNote}</div>`;
  }).join("");
  loadGlobalLeaderboard();
}

// 메인 페이지와 동일한 leaderboard 노드를 읽어, 모든 게임(Form/Wheel/Quiz/Battle/Fate)을
// 통틀어 가장 높은 점수 상위 10명을 보여준다. 게임별 스코어 스케일이 다를 수 있으므로
// game 필드를 함께 표시해 어떤 게임의 기록인지 알 수 있게 한다.
async function loadGlobalLeaderboard(){
  const el=$("globalLeaderboard");
  try{
    const snap=await get(ref(db,"leaderboard"));
    const all=snap.val()||{};
    const rows=Object.values(all).sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,10);
    if(!rows.length){el.innerHTML="<p>아직 기록이 없어.</p>";return}
    el.innerHTML=`<div class="scoreGrid" style="grid-template-columns:1fr">${rows.map((r,i)=>`
      <div class="score" style="text-align:left;display:flex;justify-content:space-between;align-items:center">
        <span>${i+1}위 · ${escapeHtml(r.nickname||"Player")} <small style="color:#9aa0ae">(${escapeHtml(r.game||"?")})</small></span>
        <b>${r.score||0}</b>
      </div>`).join("")}</div>`;
  }catch(err){
    el.innerHTML="<p>리더보드를 불러오지 못했어.</p>";
    console.error(err);
  }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
