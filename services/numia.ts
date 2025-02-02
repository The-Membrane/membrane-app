const myHeaders = new Headers();
myHeaders.append("Accept", "application/json");

const requestOptions = {
    method: "GET",
    headers: myHeaders,
    redirect: "follow"
};

export const getCDTDailyVolume = async () => {
    const data = await fetch("https://osmosis.numia.xyz/tokens/v2/factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt", requestOptions)
    const json = await data.json()
    console.log(json)
    return json as Promise<any>
}