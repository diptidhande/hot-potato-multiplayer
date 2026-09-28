import asyncio, json, random, string, time
from pathlib import Path
from aiohttp import web

ROOT=Path(__file__).parent
ROUND_MS=12000
TASK_MS=5000
MAX_STRIKES=3
MAX_PLAYERS=8
rooms={}

def now_ms(): return int(time.time()*1000)
def make_code():
    chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    while True:
        c=''.join(random.choice(chars) for _ in range(4))
        if c not in rooms:return c

def task_for():
    typ=random.choice(['tap','color','math','word'])
    if typ=='tap': return {'type':typ,'prompt':'Tap the potato 5 times!','target':5}
    if typ=='color': return {'type':typ,'prompt':'Tap the BLUE button!','target':'blue'}
    if typ=='math':
        a=random.randint(2,9); b=random.randint(2,9)
        return {'type':typ,'prompt':f'What is {a} + {b}?','answer':str(a+b)}
    word=random.choice(['QUICK','POTATO','PANIC','PASS','BOOM','RUN'])
    return {'type':typ,'prompt':'Type this word:','word':word,'answer':word}

def alive(room): return [p for p in room['players'].values() if not p['eliminated']]
def state(room):
    task=room.get('task')
    safe_task=None
    if task:
        safe_task={k:v for k,v in task.items() if k!='answer'}
    return {'code':room['code'],'status':room['status'],'hostId':room['hostId'],'round':room['round'],
            'maxStrikes':MAX_STRIKES,'potatoHolder':room.get('potatoHolder'),'deadline':room.get('deadline'),
            'task':safe_task,'taskDeadline':room.get('taskDeadline'),
            'players':[{'id':p['id'],'name':p['name'],'strikes':p['strikes'],'eliminated':p['eliminated'],'connected':p['connected']} for p in room['players'].values()],
            'winnerId':room.get('winnerId'),'message':room.get('message','')}
async def broadcast(room):
    payload=json.dumps({'type':'state','state':state(room)})
    dead=[]
    for p in room['players'].values():
        ws=p.get('ws')
        if ws and not ws.closed:
            try: await ws.send_str(payload)
            except: dead.append(p['id'])
    for pid in dead:
        room['players'][pid]['connected']=False
async def send_error(ws,msg): await ws.send_str(json.dumps({'type':'error','message':msg}))
async def start_round(room, first_id):
    room['round']+=1; room['status']='playing'; room['potatoHolder']=first_id
    room['deadline']=now_ms()+ROUND_MS; room['task']=None; room['taskDeadline']=None
    room['message']=f"Round {room['round']} — don't get caught holding it!"
    room['timer_task']=asyncio.create_task(timeout_task(room['code'], room['round'], room['deadline']))
    await broadcast(room)
async def timeout_task(code, round_no, deadline):
    await asyncio.sleep(max(0,(deadline-now_ms())/1000))
    room=rooms.get(code)
    if not room or room['status']!='playing' or room['round']!=round_no:return
    await resolve_timeout(room)
async def resolve_timeout(room):
    holder=room['players'].get(room.get('potatoHolder'))
    room['task']=None; room['taskDeadline']=None
    if not holder or holder['eliminated']: return
    holder['strikes']+=1; room['message']=f"{holder['name']} got caught! +1 strike."
    if holder['strikes']>=MAX_STRIKES:
        holder['eliminated']=True; room['message']=f"{holder['name']} got caught and is eliminated!"
    a=alive(room)
    if len(a)<=1:
        room['status']='finished'; room['winnerId']=a[0]['id'] if a else None; room['potatoHolder']=None; room['deadline']=None
        await broadcast(room); return
    await broadcast(room)
    await asyncio.sleep(1.2)
    if room['status']=='playing':
        await start_round(room,random.choice(a)['id'])
async def resolve_task(room,pid,success):
    if room['status']!='playing' or not room.get('task'):return
    p=room['players'].get(pid)
    if not p:return
    room['task']=None; room['taskDeadline']=None
    if success:
        room['message']=f"{p['name']} completed the task!"
        await broadcast(room); return
    p['strikes']+=1; room['message']=f"{p['name']} failed the task and takes a strike."
    if p['strikes']>=MAX_STRIKES:p['eliminated']=True
    a=alive(room)
    if len(a)<=1:
        room['status']='finished'; room['winnerId']=a[0]['id'] if a else None; room['potatoHolder']=None; room['deadline']=None
        await broadcast(room);return
    await start_round(room,random.choice(a)['id'])
async def handle_action(ws, room, pid, msg):
    p=room['players'].get(pid)
    action=msg.get('action')
    if action=='start':
        if room['hostId']!=pid:return
        if len(alive(room))<2:return await send_error(ws,'You need at least 2 players to start.')
        await start_round(room,random.choice(alive(room))['id']);return
    if room['status']!='playing':return
    if action=='pass':
        if room.get('potatoHolder')!=pid:return await send_error(ws,'You do not have the potato.')
        if now_ms()>=room['deadline']:return await resolve_timeout(room)
        target=room['players'].get(str(msg.get('targetId')))
        if not target or target['eliminated'] or target['id']==pid:return await send_error(ws,'Choose a living player.')
        room['potatoHolder']=target['id'];room['message']=f"{p['name']} passed the potato to {target['name']}.";await broadcast(room);return
    if action=='startTask':
        if room.get('potatoHolder')!=pid:return await send_error(ws,'You do not have the potato.')
        if room.get('task'):return
        if now_ms()>=room['deadline']:return await resolve_timeout(room)
        room['task']=task_for();room['taskDeadline']=min(room['deadline'],now_ms()+TASK_MS);room['message']='Complete the task before time runs out!';await broadcast(room)
        async def task_timeout(code,pid,td):
            await asyncio.sleep(max(0,(td-now_ms())/1000));r=rooms.get(code)
            if r and r.get('task') and r.get('potatoHolder')==pid:await resolve_task(r,pid,False)
        room['task_timer']=asyncio.create_task(task_timeout(room['code'],pid,room['taskDeadline']));return
    if action=='submitTask':
        if room.get('potatoHolder')!=pid or not room.get('task'):return
        t=room['task']; ok=False
        if now_ms()>room['taskDeadline'] or now_ms()>room['deadline']:ok=False
        elif t['type']=='tap':ok=int(msg.get('taps',0))>=t['target']
        else:ok=str(msg.get('answer','')).strip().upper()==str(t.get('target') or t.get('answer')).upper()
        await resolve_task(room,pid,ok);return
    if action=='again':
        if room['hostId']!=pid:return
        for x in room['players'].values():x['strikes']=0;x['eliminated']=False
        room.update(status='lobby',round=0,potatoHolder=None,deadline=None,task=None,taskDeadline=None,winnerId=None,message='Ready for another game.')
        await broadcast(room)
async def ws_handler(request):
    ws=web.WebSocketResponse();await ws.prepare(request)
    pid=''.join(random.choices(string.ascii_lowercase+string.digits,k=10)); room=None
    try:
        async for raw in ws:
            if raw.type!=web.WSMsgType.TEXT:continue
            msg=json.loads(raw.data); action=msg.get('action')
            if action=='create':
                name=str(msg.get('name','Player')).strip()[:18] or 'Player'; c=make_code()
                room={'code':c,'players':{},'hostId':pid,'status':'lobby','round':0,'potatoHolder':None,'deadline':None,'task':None,'taskDeadline':None,'winnerId':None,'message':'Waiting for another player…'}
                room['players'][pid]={'id':pid,'name':name,'strikes':0,'eliminated':False,'connected':True,'ws':ws};rooms[c]=room;room=room
                await ws.send_str(json.dumps({'type':'created','code':c}));await broadcast(room)
            elif action=='join':
                c=str(msg.get('roomCode','')).upper();r=rooms.get(c)
                if not r:return await send_error(ws,'Room not found. Check the code.')
                if len(r['players'])>=MAX_PLAYERS:return await send_error(ws,'Room is full.')
                name=str(msg.get('name','Player')).strip()[:18] or 'Player';r['players'][pid]={'id':pid,'name':name,'strikes':0,'eliminated':False,'connected':True,'ws':ws};room=r
                await broadcast(room)
            elif room:
                await handle_action(ws,room,pid,msg)
    finally:
        if room and pid in room['players']:
            room['players'][pid]['connected']=False;room['players'][pid]['ws']=None
            if room['status']=='lobby':
                del room['players'][pid]
                if room['hostId']==pid:
                    n=next(iter(room['players'].values()),None);room['hostId']=n['id'] if n else None
            elif room['status']=='playing' and room.get('potatoHolder')==pid:
                await resolve_timeout(room)
            await broadcast(room)
    return ws
async def index_handler(request): return web.FileResponse(ROOT/'public'/'index.html')
app=web.Application();app.router.add_get('/ws',ws_handler);app.router.add_get('/health',lambda r:web.json_response({'ok':True,'rooms':len(rooms)}));app.router.add_get('/',index_handler);app.router.add_get('/room/{code}',index_handler);app.router.add_static('/',ROOT/'public',show_index=False)
web.run_app(app,host='0.0.0.0',port=int(__import__('os').environ.get('PORT','3000')))
