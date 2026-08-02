const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso, readJson, sleep, writeJsonAtomic } = require("./util");

class CepAdapter {
    constructor(config) {
        this.tempDir = config.PREMIERE_CEP_TEMP_DIR;
        this.timeoutMs = config.PREMIERE_CEP_TIMEOUT_MS;
        this.h264Preset = config.PREMIERE_H264_PRESET;
    }

    async executeScript(script, timeoutMs = this.timeoutMs) {
        ensureDir(this.tempDir);
        const id = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const commandPath = path.join(this.tempDir, `cmd_${id}.jsx`);
        const responsePath = path.join(this.tempDir, `res_${id}.json`);
        fs.writeFileSync(commandPath, script, "utf8");

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(responsePath)) {
                const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
                fs.unlinkSync(responsePath);
                if (response && response.success === false) {
                    throw new Error(`Premiere CEP command failed: ${response.error}`);
                }
                if (response && response.data === "EvalScript error.") {
                    throw new Error("Premiere rejected the ExtendScript command.");
                }
                return response;
            }
            await sleep(200);
        }

        throw new Error(
            `Premiere CEP bridge did not respond within ${timeoutMs}ms. ` +
                `Expected the connector to watch ${this.tempDir}.`
        );
    }

    async prepareProject({ outputPath, existingProjectPath = null }) {
        ensureDir(path.dirname(outputPath));
        const script = `(function(){try{
    var outputPath=${JSON.stringify(outputPath)};
    var existingProjectPath=${JSON.stringify(existingProjectPath)};
    var outputFile=new File(outputPath);
    if(outputFile.exists){
        if(!app.project || app.project.path!==outputPath) app.openDocument(outputPath);
    }else if(existingProjectPath){
        if(!new File(existingProjectPath).exists) return JSON.stringify({success:false,error:"Existing project not found: "+existingProjectPath});
        app.openDocument(existingProjectPath);
        if(!app.project.saveAs(outputPath)) return JSON.stringify({success:false,error:"Premiere could not save the project copy"});
    }else{
        if(!app.newProject(outputPath)) return JSON.stringify({success:false,error:"Premiere could not create the project"});
    }
    if(app.project.path!==outputPath && !app.project.saveAs(outputPath)) return JSON.stringify({success:false,error:"Premiere could not save the project"});
    return JSON.stringify({success:true,projectPath:app.project.path,projectName:app.project.name});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        return this.executeScript(script, 120000);
    }

    async openProject(filePath) {
        const script = `(function(){try{
    var filePath=${JSON.stringify(filePath)};
    if(!new File(filePath).exists)return JSON.stringify({success:false,error:"Project not found: "+filePath});
    if(!app.project||app.project.path!==filePath)app.openDocument(filePath);
    if(!app.project||app.project.path!==filePath)return JSON.stringify({success:false,error:"Premiere did not open the requested project"});
    return JSON.stringify({success:true,projectPath:app.project.path,projectName:app.project.name});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        return this.executeScript(script, 120000);
    }

    async importMedia(filePaths) {
        const pathsLiteral = JSON.stringify(filePaths);
        const script = `(function(){try{
    var paths=${pathsLiteral};
    var imported=[];
    function findByPath(parent,mediaPath){
        if(!parent||!parent.children) return null;
        for(var i=0;i<parent.children.numItems;i++){
            var child=parent.children[i];
            try{if(child.getMediaPath&&child.getMediaPath()===mediaPath)return child;}catch(ignorePath){}
            var nested=findByPath(child,mediaPath);
            if(nested)return nested;
        }
        return null;
    }
    var missing=[];
    for(var p=0;p<paths.length;p++){
        if(findByPath(app.project.rootItem,paths[p])) imported.push(paths[p]);
        else missing.push(paths[p]);
    }
    if(missing.length&&!app.project.importFiles(missing,true,app.project.rootItem,false)) return JSON.stringify({success:false,error:"Premiere import failed"});
    for(var m=0;m<missing.length;m++) if(!findByPath(app.project.rootItem,missing[m])) return JSON.stringify({success:false,error:"Imported item not found: "+missing[m]});
    app.project.save();
    return JSON.stringify({success:true,imported:missing,alreadyPresent:imported});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        return this.executeScript(script, 120000);
    }

    async assembleRoughCut({ sequenceName, clips, presetPath = null }) {
        const script = `(function(){try{
    var sequenceName=${JSON.stringify(sequenceName)};
    var clips=${JSON.stringify(clips)};
    var presetPath=${JSON.stringify(presetPath)};
    var project=app.project;
    var sequence=null;
    function findByPath(parent,mediaPath){
        if(!parent||!parent.children)return null;
        for(var i=0;i<parent.children.numItems;i++){
            var child=parent.children[i];
            try{if(child.getMediaPath&&child.getMediaPath()===mediaPath)return child;}catch(ignorePath){}
            var nested=findByPath(child,mediaPath);
            if(nested)return nested;
        }
        return null;
    }
    for(var s=0;s<project.sequences.numSequences;s++) if(project.sequences[s].name===sequenceName) sequence=project.sequences[s];
    if(!sequence){
        var items=[];
        for(var c=0;c<clips.length;c++){
            var item=findByPath(project.rootItem,clips[c].assetPath);
            if(!item)return JSON.stringify({success:false,error:"Project item not found: "+clips[c].assetPath});
            items.push(item);
        }
        if(presetPath){
            if(!new File(presetPath).exists)return JSON.stringify({success:false,error:"Sequence preset not found: "+presetPath});
            if(!project.createNewSequence(sequenceName,presetPath))return JSON.stringify({success:false,error:"Premiere could not create the preset sequence"});
            for(var s2=0;s2<project.sequences.numSequences;s2++)if(project.sequences[s2].name===sequenceName)sequence=project.sequences[s2];
            if(!sequence)return JSON.stringify({success:false,error:"Created sequence not found"});
            var cursor="0";
            for(var p=0;p<items.length;p++){
                var requested=clips[p].insertionTimeTicks;
                var insertion=requested!==null&&requested!==undefined?String(requested):cursor;
                sequence.insertClip(items[p],insertion,Number(clips[p].videoTrackIndex||0),Number(clips[p].audioTrackIndex||0));
                var track=sequence.videoTracks[Number(clips[p].videoTrackIndex||0)];
                if(track.clips.numItems)cursor=track.clips[track.clips.numItems-1].end.ticks;
            }
        }else if(items.length){
            var hasExplicitPlacement=false;
            for(var explicitIndex=0;explicitIndex<clips.length;explicitIndex++){
                if(clips[explicitIndex].insertionTimeTicks!==null&&clips[explicitIndex].insertionTimeTicks!==undefined)hasExplicitPlacement=true;
            }
            if(!project.createNewSequenceFromClips(sequenceName,hasExplicitPlacement?[items[0]]:items,project.rootItem))return JSON.stringify({success:false,error:"Premiere could not create a sequence from the media"});
            for(var s3=0;s3<project.sequences.numSequences;s3++)if(project.sequences[s3].name===sequenceName)sequence=project.sequences[s3];
            if(hasExplicitPlacement&&sequence){
                for(var clearVideo=0;clearVideo<sequence.videoTracks.numTracks;clearVideo++){
                    for(var clearVideoItem=sequence.videoTracks[clearVideo].clips.numItems-1;clearVideoItem>=0;clearVideoItem--)sequence.videoTracks[clearVideo].clips[clearVideoItem].remove(false,false);
                }
                for(var clearAudio=0;clearAudio<sequence.audioTracks.numTracks;clearAudio++){
                    for(var clearAudioItem=sequence.audioTracks[clearAudio].clips.numItems-1;clearAudioItem>=0;clearAudioItem--)sequence.audioTracks[clearAudio].clips[clearAudioItem].remove(false,false);
                }
                for(var explicitClipIndex=0;explicitClipIndex<items.length;explicitClipIndex++){
                    var explicitClip=clips[explicitClipIndex];
                    var explicitItem=items[explicitClipIndex];
                    if(explicitClip.durationSeconds){
                        var explicitIn=new Time();explicitIn.seconds=0;
                        var explicitOut=new Time();explicitOut.seconds=Number(explicitClip.durationSeconds);
                        explicitItem.setInPoint(explicitIn,4);explicitItem.setOutPoint(explicitOut,4);
                    }
                    var explicitTime=String(explicitClip.insertionTimeTicks||"0");
                    if(explicitClip.overwrite){
                        sequence.overwriteClip(explicitItem,explicitTime,Number(explicitClip.videoTrackIndex||0),Number(explicitClip.audioTrackIndex||0));
                    }else{
                        sequence.insertClip(explicitItem,explicitTime,Number(explicitClip.videoTrackIndex||0),Number(explicitClip.audioTrackIndex||0));
                    }
                }
            }
        }else{
            return JSON.stringify({success:false,error:"At least one clip or a sequence preset is required"});
        }
    }
    if(!sequence)return JSON.stringify({success:false,error:"Sequence not found"});
    project.save();
    return JSON.stringify({success:true,sequenceId:sequence.sequenceID,sequenceName:sequence.name,clipsRequested:clips.length});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        return this.executeScript(script, 5 * 60 * 1000);
    }

    async createNativeCaptionTrack({ sequenceName, srtPath, requestedTrackName }) {
        if (!fs.existsSync(srtPath)) throw new Error(`Caption source does not exist: ${srtPath}`);
        const receiptPath = `${srtPath}.premiere-track.json`;
        if (fs.existsSync(receiptPath)) {
            const receipt = readJson(receiptPath);
            if (receipt.sequenceName === sequenceName && receipt.source === srtPath) {
                return { ...receipt, created: false, reused: true };
            }
        }
        const script = `(function(){try{
    var sequenceName=${JSON.stringify(sequenceName)};
    var srtPath=${JSON.stringify(srtPath)};
    var project=app.project;
    var sequence=null;
    function findByPath(parent,mediaPath){
        if(!parent||!parent.children)return null;
        for(var i=0;i<parent.children.numItems;i++){
            var child=parent.children[i];
            try{if(child.getMediaPath&&child.getMediaPath()===mediaPath)return child;}catch(ignorePath){}
            var nested=findByPath(child,mediaPath);
            if(nested)return nested;
        }
        return null;
    }
    for(var s=0;s<project.sequences.numSequences;s++)if(project.sequences[s].name===sequenceName)sequence=project.sequences[s];
    if(!sequence)return JSON.stringify({success:false,error:"Sequence not found"});
    var captionItem=findByPath(project.rootItem,srtPath);
    if(!captionItem){
        if(!project.importFiles([srtPath],true,project.rootItem,false))return JSON.stringify({success:false,error:"SRT import failed: "+srtPath});
        captionItem=findByPath(project.rootItem,srtPath);
    }
    if(!captionItem)return JSON.stringify({success:false,error:"Imported SRT project item was not found"});
    if(!project.activeSequence||project.activeSequence.sequenceID!==sequence.sequenceID)project.openSequence(sequence.sequenceID);
    if(!project.activeSequence||project.activeSequence.sequenceID!==sequence.sequenceID)return JSON.stringify({success:false,error:"Premiere could not activate the caption target sequence"});
    var created=project.activeSequence.createCaptionTrack(captionItem,0);
    if(!created)return JSON.stringify({success:false,error:"Premiere did not create a native caption track (itemType="+String(captionItem.type)+")"});
    project.save();
    return JSON.stringify({success:true,created:true,reused:false,verification:"createCaptionTrack-returned-true",requestedTrackName:${JSON.stringify(requestedTrackName)},source:srtPath});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        const result = await this.executeScript(script, 120000);
        const receipt = {
            ...result,
            sequenceName,
            source: srtPath,
            receiptPath,
            verifiedAt: nowIso(),
        };
        writeJsonAtomic(receiptPath, receipt);
        return receipt;
    }

    async applyRetentionPlan({ sequenceName, plan, captionAssets = [], showcaseAssets = {} }) {
        const sequenceLiteral = JSON.stringify(sequenceName);
        const planLiteral = JSON.stringify(plan);
        const captionAssetsLiteral = JSON.stringify(captionAssets);
        const showcaseAssetsLiteral = JSON.stringify(showcaseAssets);
        const script = `(function () {
    try {
        var project = app.project;
        var plan = ${planLiteral};
        var captionAssets = ${captionAssetsLiteral};
        var showcaseAssets = ${showcaseAssetsLiteral};
        var sequence = null;
        for (var s = 0; s < project.sequences.numSequences; s++) {
            if (project.sequences[s].name === ${sequenceLiteral}) sequence = project.sequences[s];
        }
        if (!sequence) return JSON.stringify({success:false,error:"Sequence not found"});
        if (!project.activeSequence || project.activeSequence.sequenceID !== sequence.sequenceID) {
            project.openSequence(sequence.sequenceID);
        }
        if (!project.activeSequence || project.activeSequence.sequenceID !== sequence.sequenceID) {
            return JSON.stringify({success:false,error:"Premiere could not activate the retention target sequence"});
        }
        var removed = 0;
        for (var trackIndex = 1; trackIndex < sequence.videoTracks.numTracks; trackIndex++) {
            var overlayTrack = sequence.videoTracks[trackIndex];
            for (var itemIndex = overlayTrack.clips.numItems - 1; itemIndex >= 0; itemIndex--) {
                overlayTrack.clips[itemIndex].remove(false, false);
                removed++;
            }
        }
        if(showcaseAssets.enabled){
            for(var audioTrackIndex=1;audioTrackIndex<sequence.audioTracks.numTracks;audioTrackIndex++){
                var overlayAudioTrack=sequence.audioTracks[audioTrackIndex];
                for(var audioItemIndex=overlayAudioTrack.clips.numItems-1;audioItemIndex>=0;audioItemIndex--){
                    overlayAudioTrack.clips[audioItemIndex].remove(false,false);
                    removed++;
                }
            }
        }

        var reframes = [];
        var baseTrack = sequence.videoTracks[0];
        for (var sceneIndex = 0; sceneIndex < plan.scenes.length; sceneIndex++) {
            var scene = plan.scenes[sceneIndex];
            var sourceClip = baseTrack.clips[sceneIndex];
            if (!sourceClip) return JSON.stringify({success:false,error:"Missing scene clip " + scene.sceneId});
            var compositionCamera=scene.compositionCamera;
            var useCompositionCamera=Boolean(compositionCamera&&compositionCamera.enabled);
            var focusStart=useCompositionCamera?compositionCamera.phases[1].start:scene.punchIn.start;
            var focusEnd=useCompositionCamera?compositionCamera.phases[1].end:scene.punchIn.end;
            var focusScale=useCompositionCamera?compositionCamera.scale*100:scene.punchIn.scale;
            var scaleSet = false;
            for (var componentIndex = 0; componentIndex < sourceClip.components.numItems; componentIndex++) {
                var component = sourceClip.components[componentIndex];
                if (component.matchName === "AE.ADBE Motion" || component.displayName === "Motion") {
                    for (var propertyIndex = 0; propertyIndex < component.properties.numItems; propertyIndex++) {
                        var property = component.properties[propertyIndex];
                        if (property.displayName === "Scale") {
                            var keyframes=[];
                            if(property.setTimeVarying&&property.addKey&&property.setValueAtKey){
                                property.setTimeVarying(true);
                                var oldKeys=property.getKeys?(property.getKeys()||[]):[];
                                if(property.removeKey){
                                    for(var oldKeyIndex=0;oldKeyIndex<oldKeys.length;oldKeyIndex++)property.removeKey(oldKeys[oldKeyIndex]);
                                }
                                var rampSeconds=Math.min(0.18,Math.max(0.08,(focusEnd-focusStart)/4));
                                var times=[
                                    scene.start,
                                    focusStart,
                                    focusStart+rampSeconds,
                                    focusEnd,
                                    Math.min(scene.end,focusEnd+rampSeconds),
                                    scene.end
                                ];
                                var values=[100,100,focusScale,focusScale,100,100];
                                for(var keyIndex=0;keyIndex<times.length;keyIndex++){
                                    property.addKey(times[keyIndex]);
                                    property.setValueAtKey(times[keyIndex],values[keyIndex],true);
                                    keyframes.push({time:times[keyIndex],value:values[keyIndex]});
                                }
                            }else{
                                property.setValue(focusScale,true);
                            }
                            scaleSet = true;
                            reframes.push({sceneId:scene.sceneId,scale:focusScale,keyframes:keyframes,mode:keyframes.length?(useCompositionCamera?"face-aware-composition-camera":"timed-punch-in"):"static-reframe"});
                        }
                        if(useCompositionCamera&&property.displayName==="Position"){
                            var frameWidth=Number(plan.frame&&plan.frame.width||1920);
                            var frameHeight=Number(plan.frame&&plan.frame.height||1080);
                            var currentPosition=property.getValue?property.getValue():[0.5,0.5];
                            var normalizedPosition=Number(currentPosition[0])<=2&&Number(currentPosition[1])<=2;
                            var center=normalizedPosition?[0.5,0.5]:[frameWidth/2,frameHeight/2];
                            var positionWidth=normalizedPosition?1:frameWidth;
                            var positionHeight=normalizedPosition?1:frameHeight;
                            var focused=[
                                center[0]+Number(compositionCamera.translation.x||0)*positionWidth,
                                center[1]+Number(compositionCamera.translation.y||0)*positionHeight
                            ];
                            if(property.setTimeVarying&&property.addKey&&property.setValueAtKey){
                                property.setTimeVarying(true);
                                var oldPositionKeys=property.getKeys?(property.getKeys()||[]):[];
                                if(property.removeKey){
                                    for(var oldPositionKeyIndex=0;oldPositionKeyIndex<oldPositionKeys.length;oldPositionKeyIndex++)property.removeKey(oldPositionKeys[oldPositionKeyIndex]);
                                }
                                var positionTimes=[scene.start,focusStart,focusStart+0.12,focusEnd,Math.min(scene.end,focusEnd+0.12),scene.end];
                                var positionValues=[center,center,focused,focused,center,center];
                                for(var positionKeyIndex=0;positionKeyIndex<positionTimes.length;positionKeyIndex++){
                                    property.addKey(positionTimes[positionKeyIndex]);
                                    property.setValueAtKey(positionTimes[positionKeyIndex],positionValues[positionKeyIndex],true);
                                }
                            }
                        }
                    }
                }
            }
            if (!scaleSet) return JSON.stringify({success:false,error:"Scale property not found for " + scene.sceneId});
        }

        var importedCaptions = [];
        function findProjectItemByPath(parent, mediaPath) {
            if (!parent || !parent.children) return null;
            for (var childIndex = 0; childIndex < parent.children.numItems; childIndex++) {
                var child = parent.children[childIndex];
                try { if (child.getMediaPath && child.getMediaPath() === mediaPath) return child; } catch (ignorePath) {}
                var nested = findProjectItemByPath(child, mediaPath);
                if (nested) return nested;
            }
            return null;
        }
        var graphicAnimations=[];
        var graphicAssets=captionAssets.concat(showcaseAssets.graphics||[]);
        for (var captionIndex = 0; captionIndex < graphicAssets.length; captionIndex++) {
            var caption = graphicAssets[captionIndex];
            var captionItem = findProjectItemByPath(project.rootItem, caption.path);
            if (!captionItem) {
                if (!project.importFiles([caption.path], true, project.rootItem, false)) {
                    return JSON.stringify({success:false,error:"Caption image import failed: " + caption.path});
                }
                captionItem = findProjectItemByPath(project.rootItem, caption.path);
            }
            if (!captionItem) return JSON.stringify({success:false,error:"Imported caption image not found"});
            if(captionItem.refreshMedia)captionItem.refreshMedia();
            var captionIn = new Time();
            captionIn.seconds = 0;
            var captionOut = new Time();
            captionOut.seconds = caption.end - caption.start;
            captionItem.setInPoint(captionIn, 4);
            captionItem.setOutPoint(captionOut, 4);
            var captionStart = new Time();
            captionStart.seconds = caption.start;
            var targetTrackIndex=Number(caption.trackIndex===undefined?1:caption.trackIndex);
            var targetTrack = sequence.videoTracks[targetTrackIndex];
            if(!targetTrack)return JSON.stringify({success:false,error:"Missing video overlay track "+targetTrackIndex});
            targetTrack.overwriteClip(captionItem, captionStart.ticks);
            var animation=caption.animation||null;
            if(animation){
                for(var placedGraphicIndex=0;placedGraphicIndex<targetTrack.clips.numItems;placedGraphicIndex++){
                    var placedGraphic=targetTrack.clips[placedGraphicIndex];
                    if(Math.abs(Number(placedGraphic.start.seconds)-Number(caption.start))>=0.1)continue;
                    var introEnd=Math.min(caption.end,caption.start+Number(animation.introSeconds||0.45));
                    var outroStart=Math.max(caption.start,caption.end-Number(animation.outroSeconds||0.55));
                    var receipt={id:caption.id||caption.text,opacity:[],scale:[]};
                    for(var graphicComponentIndex=0;graphicComponentIndex<placedGraphic.components.numItems;graphicComponentIndex++){
                        var graphicComponent=placedGraphic.components[graphicComponentIndex];
                        for(var graphicPropertyIndex=0;graphicPropertyIndex<graphicComponent.properties.numItems;graphicPropertyIndex++){
                            var graphicProperty=graphicComponent.properties[graphicPropertyIndex];
                            var animationTimes=[caption.start,introEnd,outroStart,caption.end];
                            if(graphicProperty.displayName==="Opacity"){
                                var oldOpacityKeys=graphicProperty.getKeys?(graphicProperty.getKeys()||[]):[];
                                if(graphicProperty.removeKey){
                                    for(var oldOpacityIndex=0;oldOpacityIndex<oldOpacityKeys.length;oldOpacityIndex++)graphicProperty.removeKey(oldOpacityKeys[oldOpacityIndex]);
                                }
                                if(graphicProperty.setTimeVarying)graphicProperty.setTimeVarying(false);
                                graphicProperty.setValue(100,true);
                                receipt.opacity.push({mode:"static-export-safe",value:100});
                            }
                            if(graphicProperty.displayName==="Scale"&&graphicProperty.setTimeVarying&&graphicProperty.addKey&&graphicProperty.setValueAtKey){
                                graphicProperty.setTimeVarying(true);
                                var oldGraphicScaleKeys=graphicProperty.getKeys?(graphicProperty.getKeys()||[]):[];
                                if(graphicProperty.removeKey){
                                    for(var oldGraphicScaleKeyIndex=0;oldGraphicScaleKeyIndex<oldGraphicScaleKeys.length;oldGraphicScaleKeyIndex++)graphicProperty.removeKey(oldGraphicScaleKeys[oldGraphicScaleKeyIndex]);
                                }
                                var graphicScaleValues=[94,100,100,96];
                                for(var graphicScaleIndex=0;graphicScaleIndex<animationTimes.length;graphicScaleIndex++){
                                    graphicProperty.addKey(animationTimes[graphicScaleIndex]);
                                    graphicProperty.setValueAtKey(animationTimes[graphicScaleIndex],graphicScaleValues[graphicScaleIndex],true);
                                    receipt.scale.push({time:animationTimes[graphicScaleIndex],value:graphicScaleValues[graphicScaleIndex]});
                                }
                            }
                            if(graphicProperty.displayName==="Position"&&caption.geometry&&caption.geometry.panel&&caption.geometry.dimensions){
                                var graphicPosition=graphicProperty.getValue?graphicProperty.getValue():[0.5,0.5];
                                var graphicNormalized=Number(graphicPosition[0])<=2&&Number(graphicPosition[1])<=2;
                                var panelCenterX=Number(caption.geometry.panel.left)+Number(caption.geometry.panel.width)/2;
                                var panelCenterY=Number(caption.geometry.panel.top)+Number(caption.geometry.panel.height)/2;
                                var positioned=graphicNormalized?[
                                    panelCenterX/Number(caption.geometry.dimensions.width),
                                    panelCenterY/Number(caption.geometry.dimensions.height)
                                ]:[panelCenterX,panelCenterY];
                                graphicProperty.setValue(positioned,true);
                                receipt.position=positioned;
                            }
                        }
                    }
                    graphicAnimations.push(receipt);
                    break;
                }
            }
            importedCaptions.push({text:caption.text,start:caption.start,end:caption.end,trackIndex:targetTrackIndex,purpose:caption.purpose||"animated-caption"});
        }

        var importedVideos=[];
        var videoAssets=showcaseAssets.videos||[];
        for(var videoIndex=0;videoIndex<videoAssets.length;videoIndex++){
            var video=videoAssets[videoIndex];
            var videoItem=findProjectItemByPath(project.rootItem,video.path);
            if(!videoItem){
                if(!project.importFiles([video.path],true,project.rootItem,false))return JSON.stringify({success:false,error:"B-roll import failed: "+video.path});
                videoItem=findProjectItemByPath(project.rootItem,video.path);
            }
            if(!videoItem)return JSON.stringify({success:false,error:"Imported B-roll was not found"});
            if(videoItem.refreshMedia)videoItem.refreshMedia();
            var sourceStart=Number(video.sourceStart||0);
            var videoIn=new Time();videoIn.seconds=sourceStart;
            var videoOut=new Time();videoOut.seconds=sourceStart+(video.end-video.start);
            videoItem.setInPoint(videoIn,4);videoItem.setOutPoint(videoOut,4);
            var videoStart=new Time();videoStart.seconds=video.start;
            var videoTrackIndex=Number(video.trackIndex===undefined?1:video.trackIndex);
            var videoTrack=sequence.videoTracks[videoTrackIndex];
            if(!videoTrack)return JSON.stringify({success:false,error:"Missing B-roll track "+videoTrackIndex});
            videoTrack.overwriteClip(videoItem,videoStart.ticks);
            for(var placedVideoIndex=0;placedVideoIndex<videoTrack.clips.numItems;placedVideoIndex++){
                var placedVideo=videoTrack.clips[placedVideoIndex];
                if(Math.abs(Number(placedVideo.start.seconds)-Number(video.start))<0.1&&placedVideo.setScaleToFrameSize){
                    placedVideo.setScaleToFrameSize();
                }
                if(Math.abs(Number(placedVideo.start.seconds)-Number(video.start))<0.1&&video.scale){
                    for(var placedComponentIndex=0;placedComponentIndex<placedVideo.components.numItems;placedComponentIndex++){
                        var placedComponent=placedVideo.components[placedComponentIndex];
                        if(placedComponent.matchName==="AE.ADBE Motion"||placedComponent.displayName==="Motion"){
                            for(var placedPropertyIndex=0;placedPropertyIndex<placedComponent.properties.numItems;placedPropertyIndex++){
                                var placedProperty=placedComponent.properties[placedPropertyIndex];
                                if(placedProperty.displayName==="Scale")placedProperty.setValue(Number(video.scale),true);
                            }
                        }
                    }
                }
            }
            for(var linkedAudioTrackIndex=1;linkedAudioTrackIndex<sequence.audioTracks.numTracks;linkedAudioTrackIndex++){
                var linkedAudioTrack=sequence.audioTracks[linkedAudioTrackIndex];
                for(var linkedAudioIndex=0;linkedAudioIndex<linkedAudioTrack.clips.numItems;linkedAudioIndex++){
                    var linkedAudio=linkedAudioTrack.clips[linkedAudioIndex];
                    if(linkedAudio.name===videoItem.name&&Math.abs(Number(linkedAudio.start.seconds)-Number(video.start))<0.1){
                        for(var linkedComponentIndex=0;linkedComponentIndex<linkedAudio.components.numItems;linkedComponentIndex++){
                            var linkedComponent=linkedAudio.components[linkedComponentIndex];
                            for(var linkedPropertyIndex=0;linkedPropertyIndex<linkedComponent.properties.numItems;linkedPropertyIndex++){
                                var linkedProperty=linkedComponent.properties[linkedPropertyIndex];
                                if(linkedComponent.matchName.indexOf("Internal Volume")===0&&linkedProperty.displayName==="Level")linkedProperty.setValue(0,true);
                            }
                        }
                    }
                }
            }
            importedVideos.push({id:video.id,path:video.path,start:video.start,end:video.end,trackIndex:videoTrackIndex});
        }

        var importedAudio=[];
        var audioAssets=showcaseAssets.audio||[];
        for(var audioIndex=0;audioIndex<audioAssets.length;audioIndex++){
            var audio=audioAssets[audioIndex];
            var audioItem=findProjectItemByPath(project.rootItem,audio.path);
            if(!audioItem){
                if(!project.importFiles([audio.path],true,project.rootItem,false))return JSON.stringify({success:false,error:"SFX import failed: "+audio.path});
                audioItem=findProjectItemByPath(project.rootItem,audio.path);
            }
            if(!audioItem)return JSON.stringify({success:false,error:"Imported SFX was not found"});
            var audioIn=new Time();audioIn.seconds=0;
            var audioOut=new Time();audioOut.seconds=audio.end-audio.start;
            audioItem.setInPoint(audioIn,4);audioItem.setOutPoint(audioOut,4);
            var audioStart=new Time();audioStart.seconds=audio.start;
            var audioTrackNumber=Number(audio.trackIndex===undefined?1:audio.trackIndex);
            var audioTrack=sequence.audioTracks[audioTrackNumber];
            if(!audioTrack)return JSON.stringify({success:false,error:"Missing SFX track "+audioTrackNumber});
            audioTrack.overwriteClip(audioItem,audioStart.ticks);
            importedAudio.push({id:audio.id,path:audio.path,start:audio.start,end:audio.end,trackIndex:audioTrackNumber});
        }

        project.save();
        return JSON.stringify({
            success:true,
            editor:"premiere-pro-cep",
            sequence:sequence.name,
            removedOverlayItems:removed,
            reframes:reframes,
            overlays:importedCaptions,
            graphicAnimations:graphicAnimations,
            broll:importedVideos,
            audio:importedAudio
        });
    } catch (error) {
        return JSON.stringify({success:false,error:String(error)});
    }
})();`;
        return this.executeScript(script, 5 * 60 * 1000);
    }

    async saveProject() {
        return this.executeScript(`(function(){try{app.project.save();return JSON.stringify({success:true,saved:true,path:app.project.path});}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`);
    }

    async probe() {
        return this.executeScript(`(function(){try{return JSON.stringify({success:true,version:app.version,project:app.project?app.project.name:null,sequence:app.project&&app.project.activeSequence?app.project.activeSequence.name:null});}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`, 10000);
    }

    async inspectProject({ sequenceName }) {
        const sequenceLiteral = JSON.stringify(sequenceName);
        const script = `(function(){
    try {
        var project = app.project;
        var sequence = null;
        for (var s = 0; s < project.sequences.numSequences; s++) {
            if (project.sequences[s].name === ${sequenceLiteral}) sequence = project.sequences[s];
        }
        var projectItems = [];
        function collect(parent) {
            if (!parent || !parent.children) return;
            for (var i = 0; i < parent.children.numItems; i++) {
                var child = parent.children[i];
                projectItems.push({name:child.name,nodeId:child.nodeId});
                collect(child);
            }
        }
        collect(project.rootItem);
        var sequences = [];
        if (sequence) {
            var videoTracks = [];
            for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
                var vItems = [];
                for (var vc = 0; vc < sequence.videoTracks[v].clips.numItems; vc++) {
                    var videoClip = sequence.videoTracks[v].clips[vc];
                    vItems.push({name:videoClip.name,durationSeconds:videoClip.duration.seconds});
                }
                videoTracks.push({index:v,tracks:vItems});
            }
            var audioTracks = [];
            for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
                var aItems = [];
                for (var ac = 0; ac < sequence.audioTracks[a].clips.numItems; ac++) {
                    var audioClip = sequence.audioTracks[a].clips[ac];
                    aItems.push({name:audioClip.name,durationSeconds:audioClip.duration.seconds});
                }
                audioTracks.push({index:a,tracks:aItems});
            }
            var settings = sequence.getSettings();
            sequences.push({
                id:sequence.sequenceID,
                name:sequence.name,
                frameSize:{width:settings.videoFrameWidth,height:settings.videoFrameHeight},
                videoTracks:videoTracks,
                audioTracks:audioTracks,
                captionTrackCount:sequence.captionTracks ? sequence.captionTracks.numTracks : 0
            });
        }
        return JSON.stringify({
            success:true,
            project:{hasProject:true,id:project.documentID||project.path,name:project.name,path:project.path,activeSequenceName:project.activeSequence?project.activeSequence.name:null,activeSequenceId:project.activeSequence?project.activeSequence.sequenceID:null},
            sequences:sequences,
            projectItems:projectItems
        });
    } catch(error) { return JSON.stringify({success:false,error:String(error)}); }
})();`;
        return this.executeScript(script);
    }

    async exportSequence({ sequenceName, outputFile, presetFile }) {
        presetFile = presetFile || this.h264Preset;
        if (!fs.existsSync(presetFile)) throw new Error(`Premiere export preset does not exist: ${presetFile}`);
        ensureDir(path.dirname(outputFile));
        const script = `(function(){try{
    var sequence = null;
    for(var i=0;i<app.project.sequences.numSequences;i++) if(app.project.sequences[i].name===${JSON.stringify(sequenceName)}) sequence=app.project.sequences[i];
    if(!sequence) return JSON.stringify({success:false,error:"Sequence not found"});
    var result=sequence.exportAsMediaDirect(${JSON.stringify(outputFile)},${JSON.stringify(presetFile)},app.encoder.ENCODE_ENTIRE);
    return JSON.stringify({success:Boolean(result),exported:Boolean(result),outputFile:${JSON.stringify(outputFile)},presetFile:${JSON.stringify(presetFile)}});
}catch(error){return JSON.stringify({success:false,error:String(error)});}})();`;
        return this.executeScript(script, 30 * 60 * 1000);
    }

}

module.exports = { CepAdapter };
