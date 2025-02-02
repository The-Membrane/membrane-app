import { NUMIA_API_KEY } from "@/config/defaults";

const myHeaders = new Headers();
myHeaders.append("Accept", "application/json");
myHeaders.append("Authorization", NUMIA_API_KEY);


const requestOptions: RequestInit = {
    method: "GET",
    headers: myHeaders,
    redirect: "follow"
};


export const getCDTDailyVolume = async () => {
    const data = await fetch("https://osmosis.numia.xyz/tokens/v2/factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt", requestOptions)
    const json = await data.json()
    console.log("numia log", json)
    return json as Promise<any>
}