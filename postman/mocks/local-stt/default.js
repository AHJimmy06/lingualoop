const http = require('http');
http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET' && req.url==='/ready') return res.end(JSON.stringify({ready:true,model:'base.en'}));
  if(req.method==='POST' && req.url==='/v1/audio/transcriptions') {
    let size=0;req.on('data',b=>{size+=b.length;});
    req.on('end',()=>{if(!size){res.statusCode=400;res.end('{}');return;}
      res.end(JSON.stringify({text:'The friends might enjoy walking in the wooded park and sharing their stories. '.repeat(80)}));});return;
  }
  res.statusCode=501;res.end(JSON.stringify({error:'Not implemented by this test dependency'}));
}).listen(process.env.PORT);
