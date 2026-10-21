package com.irisvocal.irisvocal_backend.Service;


import com.twilio.Twilio;
import com.twilio.rest.api.v2010.account.Message;
import com.twilio.type.PhoneNumber;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class TwilioSmsService {
    //Spring reads the twilio.account-sid property from application.properties, resolves its placeholder, and puts the actual value into accountSid
    @Value("${twilio.account-sid}")
    private String accountSid;

    @Value("${twilio.auth-token}")
    private String authToken;

    @Value("${twilio.phone-number}")
    private String fromNumber;
    public void sendSms(String toNumber,String smsBody){

        //Twilio is a class provided by Twilio java library
        //logging your application into the Twilio service using its credentials
        Twilio.init(accountSid, authToken);

        //The creator() method prepares a request to create a new SMS message.
        //PhoneNumber is a class from the Twilio Java library:
        Message message= Message.creator(
                new PhoneNumber(toNumber),
                new PhoneNumber(fromNumber),
                smsBody
                //This method submits the request to Twilio's API to create the message resource.
        ).create();
        //getsid is unique identifier on that messsage
        System.out.println(
                "Twilio accepted the SMS request. SID: "
                        + message.getSid()
        );
    }
}
