const fs = require("fs");
const path = require("path");
const { ensureDir, sleep } = require("./util");

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
            if(!project.createNewSequenceFromClips(sequenceName,items,project.rootItem))return JSON.stringify({success:false,error:"Premiere could not create a sequence from the media"});
            for(var s3=0;s3<project.sequences.numSequences;s3++)if(project.sequences[s3].name===sequenceName)sequence=project.sequences[s3];
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

    async applyRetentionPlan({ sequenceName, plan, captionAssets = [] }) {
        const sequenceLiteral = JSON.stringify(sequenceName);
        const planLiteral = JSON.stringify(plan);
        const captionAssetsLiteral = JSON.stringify(captionAssets);
        const script = `(function () {
    try {
        var project = app.project;
        var plan = ${planLiteral};
        var captionAssets = ${captionAssetsLiteral};
        var sequence = null;
        for (var s = 0; s < project.sequences.numSequences; s++) {
            if (project.sequences[s].name === ${sequenceLiteral}) sequence = project.sequences[s];
        }
        if (!sequence) return JSON.stringify({success:false,error:"Sequence not found"});
        var removed = 0;
        for (var trackIndex = 1; trackIndex < sequence.videoTracks.numTracks; trackIndex++) {
            var overlayTrack = sequence.videoTracks[trackIndex];
            for (var itemIndex = overlayTrack.clips.numItems - 1; itemIndex >= 0; itemIndex--) {
                overlayTrack.clips[itemIndex].remove(false, false);
                removed++;
            }
        }

        var reframes = [];
        var baseTrack = sequence.videoTracks[0];
        for (var sceneIndex = 0; sceneIndex < plan.scenes.length; sceneIndex++) {
            var scene = plan.scenes[sceneIndex];
            var sourceClip = baseTrack.clips[sceneIndex];
            if (!sourceClip) return JSON.stringify({success:false,error:"Missing scene clip " + scene.sceneId});
            var scaleSet = false;
            for (var componentIndex = 0; componentIndex < sourceClip.components.numItems; componentIndex++) {
                var component = sourceClip.components[componentIndex];
                if (component.matchName === "AE.ADBE Motion" || component.displayName === "Motion") {
                    for (var propertyIndex = 0; propertyIndex < component.properties.numItems; propertyIndex++) {
                        var property = component.properties[propertyIndex];
                        if (property.displayName === "Scale") {
                            property.setValue(scene.punchIn.scale, true);
                            scaleSet = true;
                        }
                    }
                }
            }
            if (!scaleSet) return JSON.stringify({success:false,error:"Scale property not found for " + scene.sceneId});
            reframes.push({sceneId:scene.sceneId,scale:scene.punchIn.scale});
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
        for (var captionIndex = 0; captionIndex < captionAssets.length; captionIndex++) {
            var caption = captionAssets[captionIndex];
            var captionItem = findProjectItemByPath(project.rootItem, caption.path);
            if (!captionItem) {
                if (!project.importFiles([caption.path], true, project.rootItem, false)) {
                    return JSON.stringify({success:false,error:"Caption image import failed: " + caption.path});
                }
                captionItem = findProjectItemByPath(project.rootItem, caption.path);
            }
            if (!captionItem) return JSON.stringify({success:false,error:"Imported caption image not found"});
            var captionIn = new Time();
            captionIn.seconds = 0;
            var captionOut = new Time();
            captionOut.seconds = caption.end - caption.start;
            captionItem.setInPoint(captionIn, 4);
            captionItem.setOutPoint(captionOut, 4);
            var captionStart = new Time();
            captionStart.seconds = caption.start;
            var targetTrack = sequence.videoTracks[1];
            targetTrack.overwriteClip(captionItem, captionStart.ticks);
            importedCaptions.push({text:caption.text,start:caption.start,end:caption.end});
        }

        project.save();
        return JSON.stringify({
            success:true,
            editor:"premiere-pro-cep",
            sequence:sequence.name,
            removedOverlayItems:removed,
            reframes:reframes,
            captions:importedCaptions
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
