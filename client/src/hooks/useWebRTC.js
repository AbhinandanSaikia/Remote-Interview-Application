import { useState, useEffect, useRef, useCallback } from "react";
import { socket } from "../config/socket";
import toast from "react-hot-toast";

const ICE_SERVERS = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
    ],
};

export const useWebRTC = (roomId, user, onMeetingEnded, enabled = true) => {
    const [localStream, setLocalStream] = useState(null);
    const [remoteUsers, setRemoteUsers] = useState([]); // Array of { socketId, userId, userName, stream, audioEnabled, videoEnabled }
    const [audioEnabled, setAudioEnabled] = useState(true);
    const [videoEnabled, setVideoEnabled] = useState(true);

    const peersRef = useRef(new Map()); // socketId -> RTCPeerConnection
    const localStreamRef = useRef(null);

    // Initialize local media stream
    const initLocalStream = useCallback(async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast.error("Camera and microphone are not supported in this browser.");
            setAudioEnabled(false);
            setVideoEnabled(false);
            return null;
        }

        let stream = null;
        let gotVideo = false;
        let gotAudio = false;

        // Try getting both video and audio
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });
            gotVideo = stream.getVideoTracks().length > 0;
            gotAudio = stream.getAudioTracks().length > 0;
        } catch (initialErr) {
            console.warn("Could not acquire both camera and microphone:", initialErr.name, initialErr.message);

            // User explicitly denied permission for devices
            if (initialErr.name === "NotAllowedError" || initialErr.name === "PermissionDeniedError") {
                toast.error("Camera/Mic access was blocked. Please click the site icon in your browser address bar to allow permissions.", { duration: 5000 });
                setAudioEnabled(false);
                setVideoEnabled(false);
                return null;
            }

            // Try video only (in case microphone is missing or in use)
            try {
                const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
                stream = videoStream;
                gotVideo = true;
            } catch (vErr) {
                console.warn("Video-only access failed:", vErr.name);
            }

            // Try audio only (in case camera is missing or in use)
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (stream) {
                    audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
                } else {
                    stream = audioStream;
                }
                gotAudio = true;
            } catch (aErr) {
                console.warn("Audio-only access failed:", aErr.name);
            }
        }

        if (stream) {
            localStreamRef.current = stream;
            setLocalStream(stream);
            setVideoEnabled(gotVideo);
            setAudioEnabled(gotAudio);

            if (!gotVideo && gotAudio) {
                toast("No camera detected. Joined with microphone only.", { icon: "🎙️" });
            } else if (gotVideo && !gotAudio) {
                toast("No microphone detected. Joined with camera only.", { icon: "📹" });
            }
            return stream;
        }

        // Neither video nor audio could be acquired (no hardware or blocked)
        setVideoEnabled(false);
        setAudioEnabled(false);
        toast("No camera or mic accessible. Joined in view/chat mode.", { icon: "👀" });
        return null;
    }, []);

    // Create RTCPeerConnection for a target socket
    const createPeerConnection = useCallback((targetSocketId, targetUser) => {
        if (peersRef.current.has(targetSocketId)) {
            return peersRef.current.get(targetSocketId);
        }

        const peer = new RTCPeerConnection(ICE_SERVERS);

        // Add local tracks to peer connection
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((track) => {
                peer.addTrack(track, localStreamRef.current);
            });
        }

        // Handle ICE candidates
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("ice-candidate", {
                    targetSocketId,
                    senderSocketId: socket.id,
                    candidate: event.candidate,
                });
            }
        };

        // Handle incoming remote stream tracks
        peer.ontrack = (event) => {
            const remoteStream = event.streams[0];
            setRemoteUsers((prev) => {
                const existingIndex = prev.findIndex((u) => u.socketId === targetSocketId);
                if (existingIndex > -1) {
                    const updated = [...prev];
                    updated[existingIndex] = {
                        ...updated[existingIndex],
                        stream: remoteStream,
                    };
                    return updated;
                } else {
                    return [
                        ...prev,
                        {
                            socketId: targetSocketId,
                            userId: targetUser?.userId,
                            userName: targetUser?.userName || "Participant",
                            stream: remoteStream,
                            audioEnabled: targetUser?.audioEnabled ?? true,
                            videoEnabled: targetUser?.videoEnabled ?? true,
                        },
                    ];
                }
            });
        };

        peersRef.current.set(targetSocketId, peer);
        return peer;
    }, []);

    // Main WebRTC & Socket signaling setup effect
    useEffect(() => {
        if (!roomId || !user || !enabled) return;

        let isMounted = true;

        const startSession = async () => {
            const stream = await initLocalStream();

            if (!isMounted) return;

            if (!socket.connected) {
                socket.connect();
            }

            const initialAudio = Boolean(stream && stream.getAudioTracks().length > 0 && stream.getAudioTracks()[0].enabled);
            const initialVideo = Boolean(stream && stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled);

            // Emit join room with actual device states
            socket.emit("join-room", {
                roomId,
                user,
                audioEnabled: initialAudio,
                videoEnabled: initialVideo,
            });

            // 1. Receive all existing users in room
            socket.on("all-users", (existingUsers) => {
                existingUsers.forEach((existingUser) => {
                    const peer = createPeerConnection(existingUser.socketId, existingUser);

                    // Create offer to existing user (offer to receive both audio and video even if local has none)
                    peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
                        .then((offer) => peer.setLocalDescription(offer))
                        .then(() => {
                            socket.emit("offer", {
                                targetSocketId: existingUser.socketId,
                                callerSocketId: socket.id,
                                sdp: peer.localDescription,
                            });
                        })
                        .catch((err) => console.error("Error creating offer:", err));
                });
            });

            // 2. Someone new joined -> add to state
            socket.on("user-joined", (newUser) => {
                toast(`${newUser.userName} joined the meeting`, { icon: "👋" });
                createPeerConnection(newUser.socketId, newUser);
            });

            // 3. Receive offer from caller
            socket.on("offer", async ({ callerSocketId, sdp, callerUser }) => {
                const peer = createPeerConnection(callerSocketId, callerUser);
                try {
                    await peer.setRemoteDescription(new RTCSessionDescription(sdp));
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);

                    socket.emit("answer", {
                        targetSocketId: callerSocketId,
                        responderSocketId: socket.id,
                        sdp: peer.localDescription,
                    });
                } catch (err) {
                    console.error("Error handling offer:", err);
                }
            });

            // 4. Receive answer from responder
            socket.on("answer", async ({ responderSocketId, sdp }) => {
                const peer = peersRef.current.get(responderSocketId);
                if (peer) {
                    try {
                        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
                    } catch (err) {
                        console.error("Error setting remote description from answer:", err);
                    }
                }
            });

            // 5. Receive ICE candidate
            socket.on("ice-candidate", async ({ senderSocketId, candidate }) => {
                const peer = peersRef.current.get(senderSocketId);
                if (peer && candidate) {
                    try {
                        await peer.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (err) {
                        console.error("Error adding ICE candidate:", err);
                    }
                }
            });

            // 6. Handle peer audio toggle
            socket.on("user-toggled-audio", ({ socketId, audioEnabled }) => {
                setRemoteUsers((prev) => prev.map((u) => (u.socketId === socketId ? { ...u, audioEnabled } : u)));
            });

            // 7. Handle peer video toggle
            socket.on("user-toggled-video", ({ socketId, videoEnabled }) => {
                setRemoteUsers((prev) => prev.map((u) => (u.socketId === socketId ? { ...u, videoEnabled } : u)));
            });

            // 8. Handle peer left
            socket.on("user-left", ({ socketId, user: leftUser }) => {
                if (leftUser) {
                    toast(`${leftUser.userName} left the meeting`);
                }
                const peer = peersRef.current.get(socketId);
                if (peer) {
                    peer.close();
                    peersRef.current.delete(socketId);
                }
                setRemoteUsers((prev) => prev.filter((u) => u.socketId !== socketId));
            });

            // 9. Handle meeting ended by host
            socket.on("meeting-ended", ({ message }) => {
                toast.error(message || "This meeting has ended");
                if (onMeetingEnded) {
                    onMeetingEnded(message);
                }
            });
        };

        startSession();

        // Cleanup on leave/unmount
        return () => {
            isMounted = false;

            // Stop local tracks
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((track) => track.stop());
            }

            // Close all peer connections
            peersRef.current.forEach((peer) => peer.close());
            peersRef.current.clear();

            // Off socket listeners
            socket.off("all-users");
            socket.off("user-joined");
            socket.off("offer");
            socket.off("answer");
            socket.off("ice-candidate");
            socket.off("user-toggled-audio");
            socket.off("user-toggled-video");
            socket.off("user-left");
            socket.off("meeting-ended");

            socket.disconnect();
        };
    }, [roomId, user?.id, enabled, createPeerConnection, initLocalStream, onMeetingEnded]);

    // Toggle local mic
    const toggleAudio = async () => {
        if (!localStreamRef.current || localStreamRef.current.getAudioTracks().length === 0) {
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const track = audioStream.getAudioTracks()[0];
                if (!localStreamRef.current) {
                    localStreamRef.current = new MediaStream([track]);
                    setLocalStream(localStreamRef.current);
                } else {
                    localStreamRef.current.addTrack(track);
                }
                peersRef.current.forEach((peer) => {
                    peer.addTrack(track, localStreamRef.current);
                });
                setAudioEnabled(true);
                socket.emit("toggle-audio", { roomId, audioEnabled: true });
                toast.success("Microphone enabled");
            } catch (err) {
                toast.error(err.name === "NotAllowedError" ? "Microphone permission denied" : "No microphone detected");
            }
            return;
        }

        const audioTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioTrack) {
            const newState = !audioEnabled;
            audioTrack.enabled = newState;
            setAudioEnabled(newState);
            socket.emit("toggle-audio", { roomId, audioEnabled: newState });
        }
    };

    // Toggle local camera
    const toggleVideo = async () => {
        if (!localStreamRef.current || localStreamRef.current.getVideoTracks().length === 0) {
            try {
                const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
                const track = videoStream.getVideoTracks()[0];
                if (!localStreamRef.current) {
                    localStreamRef.current = new MediaStream([track]);
                    setLocalStream(localStreamRef.current);
                } else {
                    localStreamRef.current.addTrack(track);
                }
                peersRef.current.forEach((peer) => {
                    peer.addTrack(track, localStreamRef.current);
                });
                setVideoEnabled(true);
                socket.emit("toggle-video", { roomId, videoEnabled: true });
                toast.success("Camera enabled");
            } catch (err) {
                toast.error(err.name === "NotAllowedError" ? "Camera permission denied" : "No camera detected");
            }
            return;
        }

        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoTrack) {
            const newState = !videoEnabled;
            videoTrack.enabled = newState;
            setVideoEnabled(newState);
            socket.emit("toggle-video", { roomId, videoEnabled: newState });
        }
    };

    // End meeting for everyone (Host action)
    const endMeeting = useCallback(() => {
        if (roomId) {
            socket.emit("end-meeting", { roomId });
        }
    }, [roomId]);

    return {
        localStream,
        remoteUsers,
        audioEnabled,
        videoEnabled,
        toggleAudio,
        toggleVideo,
        endMeeting,
    };
};
