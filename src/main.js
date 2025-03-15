import './style.css';
import { db, collection, doc, setDoc, addDoc, onSnapshot, getDoc, updateDoc } from './firebaseConfig.js';

// Global state for peer connection
const server = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  ],
  icecandidatePoolSize: 10,
};

let peerConnection = new RTCPeerConnection(server);
let localStream = null;
let remoteStream = null;

const webcamVideo = document.getElementById('webcamVideo');
const remoteVideo = document.getElementById('remoteVideo');
const webcamButton = document.getElementById('webcamButton');
const callInpute = document.getElementById('callInput');
const answereButton = document.getElementById('answerButton');
const hangupButton = document.getElementById('hangupButton');
const callButton = document.getElementById('callButton');

// Step 1: Setup media source
webcamButton.onclick = async () => {
  try {
    // Add mobile-friendly constraints with lower resolution options
    const constraints = {
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        facingMode: 'user' // Front camera by default
      },
      audio: true
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (!localStream) {
      return alert('Please allow permission for video call');
    }

    remoteStream = new MediaStream();

    // Push all tracks from local to peer connection
    localStream.getTracks().forEach(track => {
      console.log('got track', track);
      peerConnection.addTrack(track, localStream);
    });
    
    // Pull tracks from remote stream, add to video stream
    peerConnection.ontrack = e => {
      console.log('got track',e.streams[0]);
      e.streams[0].getTracks().forEach(track => {

        console.log('adding remote track sto remote stream', track);
        remoteStream.addTrack(track);
      });
    };


    peerConnection.onconnectionstatechange=(e)=>{
      console.log('connection state change', peerConnection.connectionState )
    }

    peerConnection.oniceconnectionstatechange=(e)=>{
      console.log('ice connection state change', peerConnection.iceConnectionState )
    }

    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = remoteStream;

    // Add buttons to switch cameras (if available)
    if (navigator.mediaDevices.enumerateDevices) {
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = deviceList.filter(device => device.kind === 'videoinput');
      
      if (videoDevices.length > 1) {
        const switchCameraButton = document.createElement('button');
        switchCameraButton.textContent = 'Switch Camera';
        switchCameraButton.onclick = switchCamera;
        document.body.appendChild(switchCameraButton);
      }
    }

    callButton.disabled = false;
    answereButton.disabled = false;
    webcamButton.disabled = true;
  } catch (err) {
    console.error('Error accessing media devices:', err);
    alert(`Error accessing camera/microphone: ${err.message}`);
  }
};

// Add function to switch between front and back cameras
async function switchCamera() {
  const currentFacingMode = localStream.getVideoTracks()[0].getSettings().facingMode;
  const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  
  // Stop all current tracks
  localStream.getTracks().forEach(track => track.stop());
  
  // Get new stream with alternate camera
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: newFacingMode },
    audio: true
  });
  
  // Replace tracks in peer connection
  const senders = peerConnection.getSenders();
  const videoTrack = localStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0];
  
  senders.forEach(sender => {
    if (sender.track.kind === 'video') {
      sender.replaceTrack(videoTrack);
    } else if (sender.track.kind === 'audio') {
      sender.replaceTrack(audioTrack);
    }
  });
  
  webcamVideo.srcObject = localStream;
}

// Add hangup functionality
hangupButton.onclick = () => {
  // Close peer connection
  peerConnection.close();
  
  // Stop local stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  
  // Reset UI
  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;
  
  // Create new peer connection for next call
  peerConnection = new RTCPeerConnection(server);
  
  // Reset buttons
  webcamButton.disabled = false;
  callButton.disabled = true;
  answereButton.disabled = true;
  hangupButton.disabled = true;
};

// Make an offer in Firestore
callButton.onclick = async () => {
  const callDoc = doc(db, 'calls', crypto.randomUUID());

  callInpute.value = callDoc.id;
  const offerCandidates = collection(callDoc ,'offerCandidates');
  const answerCandidates = collection(callDoc ,'answerCandidates');

  // Get candidates for caller, save to db
  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      addDoc(offerCandidates, event.candidate.toJSON());
    }
  };

  // Create offer
  const OfferDescription = await peerConnection.createOffer();

  // Set local description
  await peerConnection.setLocalDescription(OfferDescription);

  const offer = {
    sdp: OfferDescription.sdp,
    type: OfferDescription.type,
  };

  await setDoc(callDoc, { offer });

  // Listen for remote answer
  onSnapshot(callDoc, snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      peerConnection.setRemoteDescription(answerDescription);
    }
  });

  onSnapshot(answerCandidates, snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        peerConnection.addIceCandidate(candidate);
      }
    });
  });
};

// Answer the call
answereButton.onclick = async () => {
  const callID = callInpute.value;
  const callDoc = doc(db, 'calls', callID);
  const answerCandidates = collection(callDoc, 'answerCandidates');
  const offerCandidates = collection(callDoc, 'offerCandidates');

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      addDoc(answerCandidates, event.candidate.toJSON());
    }
  };

  const callSnap = await getDoc(callDoc);
  if (!callSnap.exists()) {
    return alert('Call not found!');
  }

  const callData = callSnap.data();
  const OfferDescription = callData.offer;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(OfferDescription));

  const answerDescription = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answerDescription);

  const answer = {
    sdp: answerDescription.sdp,
    type: answerDescription.type,
  };

  await updateDoc(callDoc, { answer });

  // Listen for ICE candidates
  onSnapshot(offerCandidates, snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
};
