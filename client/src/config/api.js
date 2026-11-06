import axios from "axios";

const api = axios.create({
    baseURL: import.meta.env.VITE_BASE_URL,
    withCredentials: true
})

api.interceptors.request.use(async (config) => {
    try {
        if (config.headers?.Authorization === "Bearer null" || config.headers?.Authorization === "Bearer undefined") {
            delete config.headers.Authorization;
        }
        if(window.Clerk?.session && !config.headers?.Authorization){
            const token = await window.Clerk.session.getToken();
            if(token){
                config.headers.Authorization = `Bearer ${token}`
            }
        }
    } catch (err) {
        console.error("Error in API request interceptor getting Clerk token:", err);
    }
    return config;
})

export default api;