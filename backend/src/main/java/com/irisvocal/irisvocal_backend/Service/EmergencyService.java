
package com.irisvocal.irisvocal_backend.Service;

import com.irisvocal.irisvocal_backend.Dto.EmergencyRequest;
import com.irisvocal.irisvocal_backend.Dto.EmergencyResponse;
import com.irisvocal.irisvocal_backend.Enums.EmergencyStatus;
import com.irisvocal.irisvocal_backend.Model.User;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.server.ResponseStatusException;

@Service
public class EmergencyService {

    private final UserService userService;
    private final SendGridEmailService sendGridEmailService;

    public EmergencyService(
            UserService userService,
            SendGridEmailService sendGridEmailService) {

        this.userService = userService;
        this.sendGridEmailService = sendGridEmailService;
    }

    public EmergencyResponse sendEmergencyAlert(
            EmergencyRequest request,
            String email) {

        // Find the authenticated user.
        User user = userService.findUserByEmail(email);

        // Read the recipient address supplied by the frontend.
       String recipientEmail=user.getEmergencyContactEmail();

        double latitude = request.getLatitude();
        double longitude = request.getLongitude();

        // Create the Google Maps location link.
        String locationUrl =
                "https://maps.google.com/?q="
                        + latitude + "," + longitude;

        // Prepare the email body.
        String emailBody =
                "IRISVOCAL EMERGENCY ALERT\n\n"
                        + "User: " + user.getName() + "\n"
                        + "Message: " + request.getMessage() + "\n"
                        + "Current location: " + locationUrl + "\n\n"
                        + "Please contact the user as soon as possible.";

        try {
            // Send the email to the frontend-supplied recipient.
            sendGridEmailService.sendEmail(
                    recipientEmail,
                    "IrisVocal Emergency Alert",
                    emailBody
            );

            return new EmergencyResponse(
                    true,
                    EmergencyStatus.ALERT_ACCEPTED,
                    "Emergency email request accepted by SendGrid.",
                    locationUrl
            );

        } catch (RestClientResponseException ex) {

            System.err.println(
                    "SendGrid returned HTTP status: "
                            + ex.getStatusCode()
            );

            throw new ResponseStatusException(
                    HttpStatus.BAD_GATEWAY,
                    "Failed to submit emergency email request."
            );

        } catch (Exception ex) {

            System.err.println(
                    "Emergency email error: "
                            + ex.getClass().getSimpleName()
            );

            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "An unexpected error occurred while processing the emergency alert."
            );
        }
    }
}
